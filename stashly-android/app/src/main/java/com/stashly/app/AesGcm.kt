/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Small AES-256-GCM helper. Used both for encrypting file contents with a
 * per-file data key (DEK) and for wrapping that DEK with the account master
 * key. Output format for both is: [12-byte IV][ciphertext][16-byte GCM tag].
 */
object AesGcm {
    private const val ALGO = "AES/GCM/NoPadding"
    private const val IV_LEN = 12
    private const val TAG_LEN_BITS = 128

    fun randomKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

    fun encrypt(keyBytes: ByteArray, plaintext: ByteArray): ByteArray {
        val iv = ByteArray(IV_LEN).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance(ALGO)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(TAG_LEN_BITS, iv))
        val ciphertext = cipher.doFinal(plaintext)
        return iv + ciphertext
    }

    fun decrypt(keyBytes: ByteArray, blob: ByteArray): ByteArray {
        if (blob.size < IV_LEN + 16) {
            throw IllegalArgumentException("Ciphertext is too short to contain IV and authentication tag")
        }
        val iv = blob.copyOfRange(0, IV_LEN)
        val ciphertext = blob.copyOfRange(IV_LEN, blob.size)
        val cipher = Cipher.getInstance(ALGO)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(TAG_LEN_BITS, iv))
        return cipher.doFinal(ciphertext)
    }
}
