/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.util.Base64

/**
 * Manages the account **master key** — the one piece of key material that
 * must never reach the broker, and that every authorized client (this
 * phone, the web dashboard, a mapped Windows drive) needs a copy of in
 * order to decrypt anything.
 *
 * KNOWN LIMITATION (skeleton scope): this class only generates/stores the
 * master key locally, encrypted at rest via Keystore-backed
 * EncryptedSharedPreferences (see SecureStorage). It does NOT yet implement
 * secure export/import to other client devices — that needs a proper
 * pairing exchange (e.g. QR-code transfer using ephemeral Diffie-Hellman,
 * similar to Signal/WhatsApp linked devices) before a second device can
 * decrypt files this phone has encrypted. Wire that up before shipping
 * multi-client support.
 *
 * Rotation: don't rotate this key on a timer. Rotate it on trust-boundary
 * events (new device paired, a device is lost/unpaired) by re-wrapping
 * every file's small DEK with the new master key — never by re-encrypting
 * file contents.
 */
class KeyManager(private val storage: SecureStorage) {

    private var cachedMasterKey: ByteArray? = null

    @Synchronized
    fun getOrCreateMasterKey(): ByteArray {
        cachedMasterKey?.let { return it.copyOf() }

        val existing = storage.masterKeyBase64
        if (existing != null) {
            val decoded = try {
                Base64.decode(existing, Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                throw IllegalStateException("Stored master key is invalid; reset and pair the node again.", e)
            }
            if (decoded.size != 32) {
                throw IllegalStateException("Stored master key is not a 256-bit key; reset and pair the node again.")
            }
            cachedMasterKey = decoded.copyOf()
            return decoded
        }

        val fresh = AesGcm.randomKey()
        storage.masterKeyBase64 = Base64.encodeToString(fresh, Base64.NO_WRAP)
        cachedMasterKey = fresh.copyOf()
        return fresh
    }

    fun wrapDek(dek: ByteArray): String {
        val wrapped = AesGcm.encrypt(getOrCreateMasterKey(), dek)
        return Base64.encodeToString(wrapped, Base64.NO_WRAP)
    }

    fun unwrapDek(wrappedBase64: String): ByteArray {
        val wrapped = Base64.decode(wrappedBase64, Base64.NO_WRAP)
        return AesGcm.decrypt(getOrCreateMasterKey(), wrapped)
    }
}
