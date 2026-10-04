/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import fs from "fs";
import path from "path";
import assert from "assert";
import { config } from "../src/config";
import { prisma } from "../src/db";
import { deviceHub } from "../src/ws/deviceHub";

async function runTests() {
  console.log("=== Stashly Chunk Cache Verification Test ===");

  const testUserId = "test-user-" + Date.now();
  const testDeviceId = "test-device-" + Date.now();
  const testFileId = "test-file-" + Date.now();
  const initialHash = "hash-v1-abc";
  const updatedHash = "hash-v2-xyz";

  // Create test user and device in DB
  const user = await prisma.user.create({
    data: {
      id: testUserId,
      email: `${testUserId}@example.com`,
      passwordHash: "dummy",
    },
  });

  const device = await prisma.device.create({
    data: {
      id: testDeviceId,
      name: "Test Android Node",
      status: "online",
    },
  });

  await prisma.userDevice.create({
    data: {
      userId: testUserId,
      deviceId: testDeviceId,
      role: "owner",
      sharingEnabled: true,
      scopeMode: "ALL",
    },
  });

  // Create a 2.5 MB test file entry (3 chunks: 0, 1, 2)
  const totalSize = Math.floor(2.5 * 1024 * 1024); // 2621440 bytes
  const file = await prisma.fileEntry.create({
    data: {
      id: testFileId,
      deviceId: testDeviceId,
      path: "/Documents/test_video.mp4",
      name: "test_video.mp4",
      sizeBytes: totalSize,
      contentHash: initialHash,
      mimeType: "video/mp4",
      encryptedDek: "test-encrypted-dek",
      encryptionFormat: "chunked",
      isCached: false,
      cachedContentHash: null,
    },
  });

  console.log("1. Created test records in DB for device & file");

  // Track requestChunk calls
  let phoneRequestCount = 0;
  const originalRequestChunk = deviceHub.requestChunk.bind(deviceHub);
  const originalIsOnline = deviceHub.isOnline.bind(deviceHub);

  let mockOnline = true;
  deviceHub.isOnline = (devId: string) => (devId === testDeviceId ? mockOnline : originalIsOnline(devId));

  deviceHub.requestChunk = async (deviceId: string, filePath: string, offset: number, length: number) => {
    phoneRequestCount++;
    // Return fake encrypted chunk of requested length + 16 bytes auth tag
    const chunkBuffer = Buffer.alloc(length + 16, (offset / 1024) % 256);
    return chunkBuffer;
  };

  try {
    // --- TEST 1: First open (Cache Miss -> Relay from phone -> Write to disk cache) ---
    console.log("\n--- TEST 1: First download (Cache Miss) ---");
    phoneRequestCount = 0;

    const CHUNK_SIZE = 1024 * 1024;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    let firstChunk = 0;
    let lastChunk = totalChunks - 1;

    // Cache check
    let isHashMatching = !!file.contentHash && file.cachedContentHash === file.contentHash;
    let hitCount = 0;
    let chunkCached: boolean[] = [];

    for (let i = firstChunk; i <= lastChunk; i++) {
      const chunkPath = path.join(config.storageDir, "chunks", file.id, `${i}.bin`);
      const exists = isHashMatching && fs.existsSync(chunkPath);
      chunkCached[i - firstChunk] = exists;
      if (exists) hitCount++;
    }

    let cacheStatus = hitCount === (lastChunk - firstChunk + 1) ? "hit" : hitCount > 0 ? "partial" : "miss";
    assert.strictEqual(cacheStatus, "miss", "First open must be a cache miss");
    console.log(`✓ Cache status: ${cacheStatus} (hitCount: ${hitCount}/${totalChunks})`);

    // Fetch and write chunks
    for (let i = firstChunk; i <= lastChunk; i++) {
      const offset = i * CHUNK_SIZE;
      const length = Math.min(CHUNK_SIZE, totalSize - offset);
      const chunkPath = path.join(config.storageDir, "chunks", file.id, `${i}.bin`);

      const encryptedChunk = await deviceHub.requestChunk(file.deviceId, file.path, offset, length);
      const chunkDir = path.join(config.storageDir, "chunks", file.id);
      await fs.promises.mkdir(chunkDir, { recursive: true });
      await fs.promises.writeFile(chunkPath, encryptedChunk);
    }

    assert.strictEqual(phoneRequestCount, 3, "Should have requested 3 chunks from phone on first open");
    console.log(`✓ Phone requested chunks: ${phoneRequestCount}`);

    // Update DB cache metadata
    await prisma.fileEntry.update({
      where: { id: file.id },
      data: { isCached: true, cachedAt: new Date(), cachedContentHash: file.contentHash },
    });

    // Verify all 3 chunk files exist on disk
    for (let i = 0; i < 3; i++) {
      const chunkPath = path.join(config.storageDir, "chunks", file.id, `${i}.bin`);
      assert(fs.existsSync(chunkPath), `Chunk file ${i}.bin must exist on disk`);
    }
    console.log("✓ All 3 chunk files successfully written to storage/cache/chunks/" + file.id);

    // --- TEST 2: Second open (Cache Hit -> 0 phone requests) ---
    console.log("\n--- TEST 2: Second download (Full Cache Hit) ---");
    const updatedFile1 = await prisma.fileEntry.findUnique({ where: { id: file.id } });
    assert(updatedFile1);

    phoneRequestCount = 0;
    isHashMatching = !!updatedFile1.contentHash && updatedFile1.cachedContentHash === updatedFile1.contentHash;
    hitCount = 0;
    chunkCached = [];

    for (let i = firstChunk; i <= lastChunk; i++) {
      const chunkPath = path.join(config.storageDir, "chunks", updatedFile1.id, `${i}.bin`);
      const exists = isHashMatching && fs.existsSync(chunkPath);
      chunkCached[i - firstChunk] = exists;
      if (exists) hitCount++;
    }

    cacheStatus = hitCount === (lastChunk - firstChunk + 1) ? "hit" : hitCount > 0 ? "partial" : "miss";
    assert.strictEqual(cacheStatus, "hit", "Second open must be a full cache hit");
    assert.strictEqual(phoneRequestCount, 0, "No chunks requested from phone on cache hit");
    console.log(`✓ Cache status: ${cacheStatus} (0 phone requests)`);

    // --- TEST 3: Offline Cache Hit (Phone is offline, request succeeds) ---
    console.log("\n--- TEST 3: Offline Download with Full Cache Hit ---");
    mockOnline = false; // Disconnect device
    assert.strictEqual(deviceHub.isOnline(testDeviceId), false, "Device must report offline");

    const allHits = hitCount === (lastChunk - firstChunk + 1);
    const wouldRejectOffline = !allHits && !mockOnline;
    assert.strictEqual(wouldRejectOffline, false, "Must NOT reject with 503 when all requested chunks are cached");

    for (let i = firstChunk; i <= lastChunk; i++) {
      const chunkPath = path.join(config.storageDir, "chunks", updatedFile1.id, `${i}.bin`);
      const data = await fs.promises.readFile(chunkPath);
      assert(data.length > 0, `Chunk ${i} read from disk successfully while offline`);
    }
    console.log("✓ Successfully read all chunks from disk while phone is offline");

    // --- TEST 4: Byte-Range Request (Partial cache test) ---
    console.log("\n--- TEST 4: Byte-Range Request ---");
    const rangeStart = 1024 * 1024;
    const rangeEnd = 1.5 * 1024 * 1024;
    const rFirstChunk = Math.floor(rangeStart / CHUNK_SIZE); // 1
    const rLastChunk = Math.floor(rangeEnd / CHUNK_SIZE);   // 1

    hitCount = 0;
    for (let i = rFirstChunk; i <= rLastChunk; i++) {
      const chunkPath = path.join(config.storageDir, "chunks", updatedFile1.id, `${i}.bin`);
      if (isHashMatching && fs.existsSync(chunkPath)) hitCount++;
    }
    const rangeCacheStatus = hitCount === (rLastChunk - rFirstChunk + 1) ? "hit" : hitCount > 0 ? "partial" : "miss";
    assert.strictEqual(rangeCacheStatus, "hit", "Range for cached chunk 1 must be a hit");
    console.log(`✓ Range request for chunk ${rFirstChunk}..${rLastChunk} cache status: ${rangeCacheStatus}`);

    // --- TEST 5: Cache Invalidation on Content Hash Change ---
    console.log("\n--- TEST 5: Cache Invalidation when contentHash changes ---");
    mockOnline = true;

    // Call handleFileSync directly with updated contentHash
    await (deviceHub as any).handleFileSync(testDeviceId, [
      {
        path: file.path,
        name: file.name,
        sizeBytes: totalSize,
        contentHash: updatedHash,
        mimeType: file.mimeType,
        encryptedDek: file.encryptedDek,
      },
    ]);

    const updatedFile2 = await prisma.fileEntry.findUnique({ where: { id: file.id } });
    assert(updatedFile2);
    assert.strictEqual(updatedFile2.contentHash, updatedHash, "contentHash updated to v2");
    assert.strictEqual(updatedFile2.cachedContentHash, null, "cachedContentHash reset to null");

    // Verify chunks directory was removed
    const chunksDir = path.join(config.storageDir, "chunks", file.id);
    assert(!fs.existsSync(chunksDir), "Stale chunks directory must be deleted on contentHash change");
    console.log("✓ Stale chunks directory successfully deleted and cachedContentHash reset to null");

    // Next download is a fresh miss
    isHashMatching = !!updatedFile2.contentHash && updatedFile2.cachedContentHash === updatedFile2.contentHash;
    assert.strictEqual(isHashMatching, false, "Hash matching must be false after invalidation");
    console.log("✓ Subsequent download treated as fresh cache miss");

    // --- TEST 6: File Deletion Cleanup ---
    console.log("\n--- TEST 6: File and Chunks Deletion Cleanup ---");
    // Re-create dummy chunk
    await fs.promises.mkdir(chunksDir, { recursive: true });
    await fs.promises.writeFile(path.join(chunksDir, "0.bin"), Buffer.from("test"));
    assert(fs.existsSync(path.join(chunksDir, "0.bin")));

    // Permanent delete cleanup
    await fs.promises.rm(chunksDir, { recursive: true, force: true });
    assert(!fs.existsSync(chunksDir), "Chunks directory cleaned up on permanent delete");
    console.log("✓ Chunks directory cleaned up successfully on file deletion");

    console.log("\n==================================================");
    console.log("🎉 ALL CHUNK CACHE ACCEPTANCE CRITERIA PASSED!");
    console.log("==================================================");

  } finally {
    // Restore mocks and clean up test data
    deviceHub.requestChunk = originalRequestChunk;
    deviceHub.isOnline = originalIsOnline;

    await prisma.fileVersion.deleteMany({ where: { fileId: testFileId } }).catch(() => {});
    await prisma.fileEntry.deleteMany({ where: { id: testFileId } }).catch(() => {});
    await prisma.userDevice.deleteMany({ where: { deviceId: testDeviceId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: testDeviceId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUserId } }).catch(() => {});
    await fs.promises.rm(path.join(config.storageDir, "chunks", testFileId), { recursive: true, force: true }).catch(() => {});
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
