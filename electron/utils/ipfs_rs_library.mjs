// =============================================================================
// ipfs_rs_library.js - Library for Reed-Solomon Encoding/Recovery via IPFS/Cluster
// Version: Internal WASM Initialization per call.
// Purpose: Provides self-contained functions encodeFile() and recoverFile().
//          Designed to be required/imported by other scripts.
// NOTE: This file ONLY defines functions and constants. It does not run anything.
// =============================================================================

// --- Required Modules ---
import { ReedSolomonErasure } from "@subspace/reed-solomon-erasure.wasm";
import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";
import crypto from 'crypto';
// --- End Required Modules ---

// --- Configuration Constants ---
// Define API endpoints and RS parameters directly.
const CLUSTER_ADD_URL = 'http://127.0.0.1:9094/add'; // IPFS Cluster Add Proxy URL
const IPFS_API_URL = 'http://127.0.0.1:5001';        // IPFS Daemon API URL
const DATA_SHARDS = 4;                               // Number of data shards
const PARITY_SHARDS = 2;                             // Number of parity shards
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;    // Total shards
const METADATA_FILENAME_PREFIX = ""; // Prefix for metadata pin name
// --- End Configuration Constants ---

// --- Internal Helper Functions (Not Exported) ---

/**
 * Determines shard size based on file size using range-based logic.
 * @param {number} fileSize - Size in bytes.
 * @returns {number} Shard size in bytes.
 */
function determineShardSize(fileSize) {
  const MB = 1024 * 1024;
  const threshold = 400 * MB; // Files <= 400MB use proportional sharding
  const cap = 100 * MB;       // Max shard size for larger files
  if (fileSize <= threshold) {
    if (fileSize === 0) return 1; // Min 1 byte shard for zero-byte file encoding
    return Math.max(1, Math.ceil(fileSize / DATA_SHARDS)); // Ensure >= 1 byte
  }
  return cap; // Apply cap for files > threshold
}

/**
 * Adds data buffer to IPFS Cluster via /add proxy endpoint.
 * Sets the pin name using the 'name' query parameter.
 * @param {Buffer} dataBuffer - Data to upload.
 * @param {string} pinName - Name for the pin metadata in Cluster.
 * @returns {Promise<string>} CID of the uploaded data.
 */
async function addDataViaCluster(dataBuffer, pinName = 'data') {
  const form = new FormData();
  form.append('file', dataBuffer, pinName);
  const encodedPinName = encodeURIComponent(pinName);
  const url = `${CLUSTER_ADD_URL}?pin=true&quieter=true&wrap-with-directory=false&name=${encodedPinName}`;

  try {
    const response = await axios.post(url, form, {
      headers: { ...form.getHeaders() },
      timeout: 180000,
      responseType: 'text'  // Force text response type
    });

    // Log the raw response for debugging
    console.log(`[Helper] Raw response data for ${pinName}:`, response.data);

    if (response.data) {
      // Try parsing as JSON first
      try {
        const jsonData = JSON.parse(response.data);
        if (jsonData.cid) return jsonData.cid;
        if (jsonData.Hash) return jsonData.Hash;
      } catch (e) {
        // If not JSON, try as plain text
        const text = response.data.toString().trim();
        if (text.startsWith('Qm') || text.startsWith('bafy')) {
          return text;
        }
      }
    }

    console.error("[Helper] Unexpected response format:", response.data);
    throw new Error(`Could not extract CID. Status: ${response.status}`);
  } catch (error) {
    console.error(`[Helper] Error adding via Cluster (${url}, Pin: "${pinName}"):`, error.message);
    throw error;
  }
}

/**
 * Fetches data from IPFS daemon via /api/v0/cat endpoint.
 * @param {string} cid - IPFS CID to fetch.
 * @returns {Promise<Buffer|null>} Fetched data as Buffer, or null on failure.
 */
async function fetchDataFromIpfs(cid) {
  const url = `${IPFS_API_URL}/api/v0/cat?arg=${cid}`;
  // console.log(`[Helper] POST ${url}`); // Verbose logging
  try {
    // Use POST for /cat to avoid potential URL length limits with GET
    const response = await axios.post( url, null, {
        responseType: 'arraybuffer',
        timeout: 120000 // 2 minutes timeout per shard fetch
    });
    return Buffer.from(response.data);
  } catch (error) {
    const status = error.response ? error.response.status : 'N/A';
    const errorBody = error.response?.data ? Buffer.from(error.response.data).toString('utf8') : '(No response body)';
    console.error(`[Helper] Error fetching CID ${cid} from IPFS (${url}). Status: ${status}. Error: ${error.message}. Body: ${errorBody}`);
    if (error.code === 'ECONNABORTED') { console.error(`[Helper] IPFS fetch timed out for CID ${cid}.`); }
    return null; // Indicate fetch failure
  }
}

// Add hash function
function hashUserKey(userKey) {
  return crypto.createHash('sha256').update(userKey).digest('hex');
}

// --- Exported Core Functions ---

/**
 * Encodes a file using Reed-Solomon, uploads shards and metadata via IPFS Cluster,
 * ensuring the metadata pin gets a specific prefixed name.
 * Initializes the WASM module internally on each call.
 *
 * @param {string} filePath - The path to the input file to encode.
 * @param {string} userKey - The user's key to use as prefix for filenames.
 * @returns {Promise<string>} The CID of the uploaded metadata file.
 * @throws {Error} If WASM init, encoding, file access, or upload fails.
 */
export async function encodeFile(filePath, userKey) {
  // Input Validation for userKey
  if (!userKey || typeof userKey !== 'string') {
    throw new Error("[Encode] Invalid user key provided.");
  }

  // Hash the user key
  const hashedKey = hashUserKey(userKey);
  console.log(`[Encode] Using hashed key: ${hashedKey}`);

  let reedSolomonErasure;
  try {
    console.log("[Encode] Initializing Reed-Solomon WASM...");
    reedSolomonErasure = await ReedSolomonErasure.fromCurrentDirectory();
    console.log("[Encode] WASM Initialized.");
  } catch (wasmError) {
    console.error("[Encode] FATAL: Failed to initialize Reed-Solomon WASM:", wasmError);
    throw new Error(`Failed to initialize WASM: ${wasmError.message}`);
  }

  // Input Validation
  if (!filePath || typeof filePath !== 'string') {
    throw new Error("[Encode] Invalid file path provided.");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`[Encode] Input file "${filePath}" does not exist or is not accessible.`);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`[Encode] Input path "${filePath}" is not a file.`);
    }
  } catch (err) {
    throw new Error(`[Encode] Cannot access file stats for "${filePath}": ${err.message}`);
  }

  // Get file information
  const originalFileName = path.basename(filePath);
  const originalSize = stat.size;
  const SHARD_SIZE = determineShardSize(originalSize);

  // Create user-specific metadata prefix using hashed key
  const userMetadataPrefix = `${hashedKey}_`;

  console.log(`[Encode] Starting encoding for: ${filePath}`);
  console.log(`[Encode] Original Size: ${originalSize}, Shard Size: ${SHARD_SIZE}, Data/Parity: ${DATA_SHARDS}/${PARITY_SHARDS}`);

  const metadata = {
    originalFileName,
    originalSize,
    shardSize: SHARD_SIZE,
    dataShards: DATA_SHARDS,
    parityShards: PARITY_SHARDS,
    createdAt: new Date().toISOString(),
    chunkGroups: [],
  };

  const chunkGroupSize = DATA_SHARDS * SHARD_SIZE;
  const totalChunkGroups = originalSize === 0 ? 1 : Math.ceil(originalSize / chunkGroupSize);
  console.log(`[Encode] Processing in ${totalChunkGroups} chunk group(s).`);

  let chunkGroupIndex = 0;
  const readStream = fs.createReadStream(filePath, { highWaterMark: chunkGroupSize });

  try {
    if (originalSize === 0) {
      console.log("[Encode] --- Processing Chunk Group 1 (Zero-byte file) ---");
      const shards = new Uint8Array(TOTAL_SHARDS * SHARD_SIZE);
      const encodeResult = reedSolomonErasure.encode(shards, DATA_SHARDS, PARITY_SHARDS);
      if (encodeResult !== 0) throw new Error(`[Encode] RS encode failed (zero-byte): code ${encodeResult}`);

      const uploadPromises = Array.from({ length: TOTAL_SHARDS }).map(async (_, i) => {
        const shardData = Buffer.from(shards.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE));
        const shardPinName = `${originalFileName}.chunk${chunkGroupIndex}.shard${i}`;
        const cid = await addDataViaCluster(shardData, shardPinName);
        return cid;
      });
      metadata.chunkGroups.push(await Promise.all(uploadPromises));
      chunkGroupIndex++;
      console.log("[Encode] Zero-byte file shards uploaded.");
    } else {
      let bytesProcessed = 0;
      for await (const chunk of readStream) {
        console.log(`[Encode] --- Processing Chunk Group ${chunkGroupIndex + 1}/${totalChunkGroups} ---`);
        const currentChunkSize = chunk.length;
        bytesProcessed += currentChunkSize;
        console.log(`[Encode] Read ${currentChunkSize} bytes. Total: ${bytesProcessed}/${originalSize}`);

        const shards = new Uint8Array(TOTAL_SHARDS * SHARD_SIZE);
        let sourceOffset = 0;
        for (let i = 0; i < DATA_SHARDS; i++) {
          const bytesToCopy = Math.min(SHARD_SIZE, currentChunkSize - sourceOffset);
          if (bytesToCopy > 0) {
            shards.set(chunk.slice(sourceOffset, sourceOffset + bytesToCopy), i * SHARD_SIZE);
            sourceOffset += bytesToCopy;
          }
        }

        const encodeResult = reedSolomonErasure.encode(shards, DATA_SHARDS, PARITY_SHARDS);
        if (encodeResult !== 0) throw new Error(`[Encode] RS encode failed chunk ${chunkGroupIndex}: code ${encodeResult}`);
        console.log(`[Encode] Encoded chunk group ${chunkGroupIndex}.`);

        const uploadPromises = Array.from({ length: TOTAL_SHARDS }).map(async (_, i) => {
          const shardData = Buffer.from(shards.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE));
          const shardPinName = `${originalFileName}.chunk${chunkGroupIndex}.shard${i}`;
          const cid = await addDataViaCluster(shardData, shardPinName);
          return cid;
        });
        metadata.chunkGroups.push(await Promise.all(uploadPromises));
        console.log(`[Encode] Uploaded shards for group ${chunkGroupIndex}.`);
        chunkGroupIndex++;
      }
    }
  } finally {
    if (readStream && !readStream.destroyed) {
      readStream.destroy();
    }
  }

  console.log("[Encode] Preparing metadata for upload...");
  const metadataBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
  const specificMetadataPinName = `${userMetadataPrefix}${originalFileName}`;
  console.log(`[Encode] Uploading metadata with pin name "${specificMetadataPinName}"...`);
  const metadataCid = await addDataViaCluster(metadataBuffer, specificMetadataPinName);
  console.log(`[Encode] Metadata uploaded. CID: ${metadataCid}`);
  console.log(`[Encode] Encoding complete for ${filePath}. Metadata CID: ${metadataCid}`);

  // Return the structured response
  const response = {
    status: 'completed',
    name: originalFileName,
    cid: metadataCid,
    size: originalSize,
    details: {
      originalFileName: originalFileName,
      originalSize,
      shardSize: SHARD_SIZE,
      dataShards: DATA_SHARDS,
      parityShards: PARITY_SHARDS,
      totalChunks: totalChunkGroups,
      processedChunks: chunkGroupIndex,
      chunkGroups: metadata.chunkGroups,
      createdAt: metadata.createdAt
    }
  };

  console.log("[Encode] Final response:", JSON.stringify(response, null, 2));
  return response;
}


/**
 * Fetches metadata and shards based on CIDs from IPFS, reconstructs the original
 * file using Reed-Solomon if necessary, and saves it to the specified directory.
 * Initializes the WASM module internally on each call.
 *
 * @param {string} metadataCid - The IPFS CID of the metadata file.
 * @param {string} outputDir - The directory path where the recovered file should be saved.
 * @returns {Promise<string>} The full path to the successfully recovered file.
 * @throws {Error} If WASM init, recovery fails due to missing data, network errors, or reconstruction issues.
 */
export async function recoverFile(metadataCid, outputDir) {
   let reedSolomonErasure;
   try {
     // --- Initialize WASM ---
     console.log("[Recover] Initializing Reed-Solomon WASM...");
     reedSolomonErasure = await ReedSolomonErasure.fromCurrentDirectory();
     console.log("[Recover] WASM Initialized.");
     // --- End WASM Init ---
   } catch (wasmError) {
     console.error("[Recover] FATAL: Failed to initialize Reed-Solomon WASM:", wasmError);
     throw new Error(`Failed to initialize WASM: ${wasmError.message}`);
   }

   // --- Input Validation ---
   if (!metadataCid || typeof metadataCid !== 'string') {
       throw new Error("[Recover] Invalid metadata CID provided.");
   }
   if (!outputDir || typeof outputDir !== 'string') {
       throw new Error("[Recover] Invalid output directory provided.");
   }
   if (!/^(Qm|bafy|baga)[a-zA-Z0-9]{40,}$/.test(metadataCid)) {
       console.warn(`[Recover] Warning: Provided metadata CID "${metadataCid}" might not be standard IPFS format.`);
   }
   // --- End Validation ---

   console.log(`[Recover] Starting recovery for metadata CID: ${metadataCid}`);
   console.log(`[Recover] Output directory: ${outputDir}`);

   // 1. Fetch and Parse Metadata
   console.log("[Recover] Fetching metadata from IPFS...");
   const metadataBuffer = await fetchDataFromIpfs(metadataCid);
   if (!metadataBuffer) throw new Error(`[Recover] Failed to fetch metadata (CID: ${metadataCid}). Cannot proceed.`);
   let metadata;
   try {
       metadata = JSON.parse(metadataBuffer.toString('utf8'));
       if (!metadata.originalFileName || metadata.originalSize === undefined || !metadata.shardSize || !metadata.dataShards || !metadata.parityShards || !metadata.chunkGroups) {
           throw new Error("[Recover] Metadata content is incomplete or invalid.");
       }
   } catch (parseError) { throw new Error(`[Recover] Failed to parse metadata JSON (CID: ${metadataCid}). Error: ${parseError.message}`); }

   const { originalFileName, originalSize, shardSize, dataShards, parityShards, chunkGroups } = metadata;
   console.log(`[Recover] Details: Size=${originalSize}, ShardSize=${shardSize}, Data/Parity: ${dataShards}/${parityShards}, Groups: ${chunkGroups.length}`);
   if (shardSize <= 0) throw new Error(`[Recover] Invalid shard size (${shardSize}) in metadata.`);

   // 2. Prepare Output Directory and File Stream
   try {
       if (!fs.existsSync(outputDir)) {
           console.log(`[Recover] Creating output directory: ${outputDir}`);
           fs.mkdirSync(outputDir, { recursive: true });
       }
   } catch (dirError) { throw new Error(`[Recover] Failed to create output directory "${outputDir}": ${dirError.message}`); }

   const outputPath = path.join(outputDir, `recovered_${originalFileName}`);
   let writeStream;
   try {
       writeStream = fs.createWriteStream(outputPath);
       console.log(`[Recover] Opened output file stream: ${outputPath}`);
   } catch (fileError) { throw new Error(`[Recover] Failed to open output file "${outputPath}": ${fileError.message}`); }

   // 3. Process Chunk Groups
   let totalBytesWritten = 0;
   try {
       for (let chunkGroupIndex = 0; chunkGroupIndex < chunkGroups.length; chunkGroupIndex++) {
           console.log(`[Recover] --- Processing Chunk Group ${chunkGroupIndex + 1}/${chunkGroups.length} ---`);
           const groupCids = chunkGroups[chunkGroupIndex];
           if (!Array.isArray(groupCids) || groupCids.length !== TOTAL_SHARDS) {
               throw new Error(`[Recover] Invalid CIDs structure for group ${chunkGroupIndex}.`);
           }

           // Fetch shards
           const fetchedShardsData = new Array(TOTAL_SHARDS).fill(null);
           const present = new Array(TOTAL_SHARDS).fill(false);
           const fetchPromises = groupCids.map(async (shardCid, shardIndex) => {
               if (!shardCid) { present[shardIndex] = false; return; }
               const shardDataBuffer = await fetchDataFromIpfs(shardCid);
               if (shardDataBuffer) {
                   const finalShardData = new Uint8Array(shardSize); // Ensure fixed size
                   if (shardDataBuffer.length > shardSize) {
                       finalShardData.set(shardDataBuffer.slice(0, shardSize)); // Truncate
                   } else {
                       finalShardData.set(shardDataBuffer); // Pad with zeros if shorter
                   }
                   fetchedShardsData[shardIndex] = finalShardData;
                   present[shardIndex] = true;
               } else { present[shardIndex] = false; }
           });
           await Promise.all(fetchPromises);

           // Check shard count and reconstruct if needed
           const fetchedCount = present.filter(Boolean).length;
           console.log(`[Recover] Fetched ${fetchedCount}/${TOTAL_SHARDS} shards. Need ${DATA_SHARDS}.`);
           if (fetchedCount < DATA_SHARDS) {
               throw new Error(`[Recover] Not enough shards for group ${chunkGroupIndex} (${fetchedCount} < ${DATA_SHARDS}).`);
           }

           const shardsBufferForRS = new Uint8Array(TOTAL_SHARDS * shardSize);
           for (let i = 0; i < TOTAL_SHARDS; i++) {
               if (present[i]) shardsBufferForRS.set(fetchedShardsData[i], i * shardSize);
           }

           let needReconstruction = false;
           for (let i = 0; i < DATA_SHARDS; i++) if (!present[i]) { needReconstruction = true; break; }

           if (needReconstruction) {
               console.log(`[Recover]   Reconstruction needed for group ${chunkGroupIndex}.`);
               const reconstructResult = reedSolomonErasure.reconstruct(shardsBufferForRS, DATA_SHARDS, PARITY_SHARDS, present);
               if (reconstructResult !== 0) throw new Error(`[Recover] RS reconstruct failed group ${chunkGroupIndex}: code ${reconstructResult}.`);
               console.log(`[Recover]   Reconstruction successful.`);
           } else { console.log(`[Recover]   Reconstruction not required.`); }

           // Write data shards to file
           const maxBytesInThisGroup = DATA_SHARDS * shardSize;
           const remainingBytesInFile = originalSize - totalBytesWritten;
           const bytesToWrite = Math.min(maxBytesInThisGroup, remainingBytesInFile);

           if (bytesToWrite > 0) {
               let groupDataBuffer = Buffer.alloc(0);
               for (let i = 0; i < DATA_SHARDS; i++) { // Only data shards
                   groupDataBuffer = Buffer.concat([groupDataBuffer, Buffer.from(shardsBufferForRS.slice(i * shardSize, (i + 1) * shardSize))]);
               }
               const finalGroupDataToWrite = groupDataBuffer.slice(0, bytesToWrite);
               if (!writeStream.write(finalGroupDataToWrite)) {
                   await new Promise(resolve => writeStream.once('drain', resolve)); // Handle backpressure
               }
               totalBytesWritten += finalGroupDataToWrite.length;
               console.log(`[Recover] Written ${finalGroupDataToWrite.length} bytes. Total: ${totalBytesWritten}/${originalSize}`);
           } else if (originalSize === 0 && chunkGroupIndex === 0) {
               console.log("[Recover] Skipping write for zero-byte file.");
           }
       } // End group loop

       // Finalize stream and verify size
       await new Promise((resolve, reject) => {
           writeStream.end(err => {
               if (err) { reject(err); return; }
               console.log(`[Recover] Output stream closed. Verifying final size...`);
               try {
                   const stats = fs.statSync(outputPath);
                   if (stats.size !== originalSize) {
                       const errMsg = `CRITICAL: Recovered size (${stats.size}) != original size (${originalSize})! File corrupted.`;
                       console.error(`[Recover] ${errMsg}`);
                       try { fs.unlinkSync(outputPath); } catch (delErr) {/* Ignore unlink error */}
                       reject(new Error(errMsg));
                   } else {
                       console.log(`[Recover] Final size verified (${originalSize} bytes).`);
                       resolve();
                   }
               } catch (statError) { reject(statError); }
           });
       });

   } catch (error) { // Cleanup on error during processing
       if (writeStream && !writeStream.destroyed) writeStream.end();
       if (fs.existsSync(outputPath)) {
           try { fs.unlinkSync(outputPath); console.log(`[Recover] Deleted partial file on error: ${outputPath}`); }
           catch (delErr) { console.error(`[Recover] Failed to delete partial file: ${delErr.message}`); }
       }
       throw error; // Re-throw the processing error
   }

   console.log(`[Recover] Recovery complete. Output: ${outputPath}`);
   return outputPath; // Return the full path
}

/**
 * Deletes metadata and shards from IPFS cluster based on the given metadata CID.
 * @param {string} metadataCid - The IPFS CID of the metadata file.
 * @returns {Promise<object>} A report of deleted CIDs.
 */
export async function deleteFile(metadataCid) {
  // 1. Fetch Metadata
  console.log(`[Delete] Fetching metadata for CID: ${metadataCid}`);
  const metadataBuffer = await fetchDataFromIpfs(metadataCid);
  if (!metadataBuffer) {
    throw new Error(`[Delete] Failed to fetch metadata (CID: ${metadataCid}).`);
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataBuffer.toString('utf8'));
  } catch (parseError) {
    throw new Error(`[Delete] Failed to parse metadata JSON: ${parseError.message}`);
  }

  const { chunkGroups } = metadata;
  if (!Array.isArray(chunkGroups) || chunkGroups.length === 0) {
    throw new Error(`[Delete] Metadata does not contain valid chunk groups.`);
  }

  console.log(`[Delete] Metadata fetched. Preparing to delete shards...`);

  // 2. Delete all shard CIDs and metadata CID
  const allCids = chunkGroups.flat().filter(Boolean); // Flatten and remove empty
  allCids.push(metadataCid); // Also delete metadata itself

  const deleteResults = [];

  for (const cid of allCids) {
    try {
      console.log(`[Delete] Attempting to delete CID: ${cid}`);
      const response = await fetch(`http://localhost:9094/pins/${cid}`, { method: 'DELETE' });
      if (!response.ok) {
        console.warn(`[Delete] Warning: Failed to delete CID ${cid} (status: ${response.status})`);
      } else {
        console.log(`[Delete] Successfully deleted CID: ${cid}`);
        deleteResults.push({ cid, status: 'deleted' });
      }
    } catch (deleteError) {
      console.error(`[Delete] Error deleting CID ${cid}:`, deleteError.message);
      deleteResults.push({ cid, status: 'failed', error: deleteError.message });
    }
  }

  console.log(`[Delete] Deletion process finished.`);
  return { deleted: deleteResults };
}

// export recoverFile;
// export encodeFile;

// export default {recoverFile, encodeFile};

// --- Exports ---
// Export only the two primary functions.
// module.exports = {
//   encodeFile,
//   recoverFile
// };
// =============================================================================
// End of library: ipfs_rs_library.js
// =============================================================================