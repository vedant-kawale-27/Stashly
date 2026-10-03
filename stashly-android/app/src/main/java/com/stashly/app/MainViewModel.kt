/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import androidx.lifecycle.ViewModel

/** Activity-scoped UI state that should survive configuration changes. */
class MainViewModel : ViewModel() {
    var selectedPage: Int = 0
    var pendingScopePairing: PairingResult? = null
    var pendingScopeIsPairing: Boolean = true
    var pendingScopeTargetUserId: String? = null
}
