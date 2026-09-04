/**
 * MDM Application - Real-Time Cloud & WhatsApp Multi-Device Sync Engine
 * 
 * Triple-Tier Sync System:
 * 1. 100% Reliable WhatsApp 1-Click Data Transfer & Sync (No server needed, works offline)
 * 2. Google Firebase Realtime Database Live REST Cloud Sync
 * 3. 1-Click JSON Local Backup & Restore
 */

const cloudSync = {
  config: {
    enabled: false,
    autoSync: true,
    schoolCode: '',             // e.g. UDISE: 27240801201
    secretPin: 'Ican@123',      // Security PIN
    firebaseUrl: '',            // Firebase Realtime Database URL
    lastSyncTime: null,
    status: 'idle',             // 'idle', 'syncing', 'synced', 'error', 'offline'
    lastError: ''
  },

  isSyncing: false,
  debounceTimer: null,

  SYNC_STORAGE_KEY: 'MDM_CLOUD_SYNC_CONFIG',

  /**
   * Schedule debounced cloud auto-push (waits 3 seconds after last save to prevent blinking/loops)
   */
  scheduleDebouncedPush() {
    if (this.isSyncing) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (!this.isSyncing && this.config.enabled && this.config.firebaseUrl && this.config.autoSync) {
        this.pushToCloud(true);
      }
    }, 3000);
  },

  init() {
    this.loadConfig();
    this.bindOnlineEvents();
    this.checkUrlParamsForDataImport();
    
    // Auto sync on startup if Firebase is configured
    if (this.config.enabled && this.config.firebaseUrl && this.config.schoolCode) {
      setTimeout(() => {
        this.pullFromCloud(true);
      }, 600);
    }

    this.updateUIStatus();
  },

  loadConfig() {
    try {
      const saved = localStorage.getItem(this.SYNC_STORAGE_KEY);
      if (saved) {
        this.config = Object.assign({}, this.config, JSON.parse(saved));
      }
    } catch (e) {
      console.warn("Could not load cloud sync config:", e);
    }
  },

  /**
   * Check URL parameters for 1-Click WhatsApp data imports
   */
  checkUrlParamsForDataImport() {
    try {
      if (typeof window === 'undefined' || !window.location || !window.location.search) return;
      const urlParams = new URLSearchParams(window.location.search);
      
      // 1. Full School Data Import (?mdm_import=...)
      if (urlParams.has('mdm_import')) {
        const raw = urlParams.get('mdm_import');
        if (raw) {
          const jsonStr = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
          const pkg = JSON.parse(jsonStr);
          if (pkg && pkg.r && typeof app !== 'undefined') {
            if (pkg.s) app.data.settings = Object.assign({}, app.data.settings, pkg.s);
            if (pkg.r) app.data.records = Object.assign({}, app.data.records, pkg.r);
            if (pkg.sr) app.data.stockReceipts = pkg.sr;
            if (pkg.ds) app.data.damagedStock = pkg.ds;
            if (pkg.is) app.data.initialStock = Object.assign({}, app.data.initialStock, pkg.is);
            if (pkg.cd) app.data.customDemands = pkg.cd;
            if (pkg.fr) app.data.formBRemarks = pkg.fr;

            app.saveState();
            app.refreshAllViews();
            app.renderCurrentTab();

            // Clear query param from browser bar
            if (window.history && window.history.replaceState) {
              window.history.replaceState({}, document.title, window.location.pathname);
            }
            setTimeout(() => {
              app.showToast('🎉 WhatsApp द्वारे संपूर्ण शाळा डेटा यशस्वीरित्या आयात झाला!', 'success');
            }, 600);
          }
        }
      }

      // 2. Single Day Entry Import (?mdm_daily_entry=...)
      if (urlParams.has('mdm_daily_entry')) {
        const raw = urlParams.get('mdm_daily_entry');
        if (raw) {
          const jsonStr = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
          const item = JSON.parse(jsonStr);
          if (item && item.d && item.r && typeof app !== 'undefined') {
            app.data.records[item.d] = item.r;
            app.saveState();
            app.refreshAllViews();
            app.renderCurrentTab();

            if (window.history && window.history.replaceState) {
              window.history.replaceState({}, document.title, window.location.pathname);
            }
            setTimeout(() => {
              app.showToast(`✅ दैनिक नोंद (${item.d}) यशस्वीरित्या जोडली गेली!`, 'success');
            }, 600);
          }
        }
      }
    } catch (e) {
      console.warn("Could not import data from URL params:", e);
    }
  },

  saveConfig() {
    try {
      localStorage.setItem(this.SYNC_STORAGE_KEY, JSON.stringify(this.config));
      this.updateUIStatus();
    } catch (e) {
      console.warn("Could not save cloud sync config:", e);
    }
  },

  bindOnlineEvents() {
    window.addEventListener('online', () => {
      this.config.lastError = '';
      this.updateUIStatus();
      if (this.config.enabled && this.config.firebaseUrl && this.config.autoSync) {
        this.pushToCloud(true);
      }
    });

    window.addEventListener('offline', () => {
      this.config.status = 'offline';
      this.updateUIStatus();
    });
  },

  getSchoolUdise() {
    return String(
      (typeof app !== 'undefined' && app.data && app.data.settings && app.data.settings.udise)
      || localStorage.getItem('MDM_CURRENT_UDISE')
      || this.config.schoolCode
      || '27240304501'
    ).trim();
  },

  getCloudKey() {
    const udise = this.getSchoolUdise().replace(/[^a-zA-Z0-9_-]/g, '_');
    return `mdm_${udise}`;
  },

  /**
   * Handle dynamic school switching: updates active UDISE and sync state
   */
  onSchoolSwitched(newUdise) {
    if (newUdise) {
      this.config.schoolCode = String(newUdise).trim();
      this.config.status = 'idle';
      this.config.lastError = '';
      this.saveConfig();
      this.updateUIStatus();
    }
  },

  /**
   * Push current state to Google Firebase Cloud Database
   */
  async pushToCloud(isSilent = false) {
    if (!this.config.firebaseUrl) {
      if (!isSilent) {
        app.showToast('ℹ️ थेट क्लाऊडसाठी कृपया Firebase Database URL प्रविष्ट करा किंवा WhatsApp सिंक वापरा.', 'info');
      }
      return false;
    }

    if (this.isSyncing) {
      return false;
    }
    this.isSyncing = true;

    if (!navigator.onLine) {
      this.isSyncing = false;
      this.config.status = 'offline';
      this.config.lastError = 'इंटरनेट कनेक्शन नाही.';
      this.updateUIStatus();
      if (!isSilent) app.showToast('⚠️ इंटरनेट उपलब्ध नाही. इंटरनेट सुरू झाल्यावर डेटा क्लाऊडवर सेव्ह होईल.', 'warning');
      return false;
    }

    this.config.status = 'syncing';
    this.updateUIStatus();

    const cleanBaseUrl = this.config.firebaseUrl.trim().replace(/\/$/, '');
    const currentUdise = this.getSchoolUdise();
    this.config.schoolCode = currentUdise;
    const endpoint = `${cleanBaseUrl}/mdm_schools/${this.getCloudKey()}.json`;

    const payload = {
      version: "2.0",
      schoolCode: currentUdise,
      updatedAt: new Date().toISOString(),
      updatedBy: (app.data && app.data.settings && app.data.settings.headmaster) || 'User',
      appData: app.data
    };

    try {
      // 1. Pre-Push Safety Check: Fetch existing remote state to prevent accidental blank overwrite
      let existingRemote = null;
      try {
        const checkRes = await fetch(endpoint);
        if (checkRes.ok) {
          existingRemote = await checkRes.json();
        }
      } catch (checkErr) {
        console.warn("Could not pre-check remote bucket:", checkErr);
      }

      const localRecCount = Object.keys((app.data && app.data.records) || {}).length;
      const remoteRecCount = (existingRemote && existingRemote.appData && existingRemote.appData.records)
        ? Object.keys(existingRemote.appData.records).length : 0;

      // GUARD 1: Prevent Blank / Empty Device from wiping existing cloud data!
      if (localRecCount === 0 && remoteRecCount > 0) {
        this.config.status = 'idle';
        this.updateUIStatus();
        const warnMsg = `⛔ डेटा सुरक्षा इशारा (डेटा नष्ट होण्यापासून रोखला!):\n\nया डिव्हाइसवर 0 दैनंदिन नोंदी आहेत, तर क्लाऊडवर आधीच ${remoteRecCount} नोंदी सुरक्षित साठवलेल्या आहेत!\n\nरिकामा डेटा अपलोड केल्यास मूळ डेटा नष्ट होईल, म्हणून सिस्टिमने हा रिकामा डेटा रोखला आहे.\n\nकृपया प्रथम खालील "📥 क्लाऊडवरून आणा" (Pull) बटण दाबा जेणेकरून क्लाऊडवरील सर्व डेटा या डिव्हाइसवर येईल.`;
        if (!isSilent) alert(warnMsg);
        else console.warn(warnMsg);
        return false;
      }

      // GUARD 2: Smart Merge - If remote has records and local has records, merge them so no dates are lost!
      if (existingRemote && existingRemote.appData && remoteRecCount > 0) {
        const mergedRecords = Object.assign({}, existingRemote.appData.records, app.data.records);
        const mergedTaste = Object.assign({}, existingRemote.appData.tasteRecords, app.data.tasteRecords);
        const mergedReceipts = [...(existingRemote.appData.stockReceipts || [])];
        (app.data.stockReceipts || []).forEach(lr => {
          if (!mergedReceipts.some(mr => mr.date === lr.date && mr.itemKey === lr.itemKey && mr.quantity === lr.quantity)) {
            mergedReceipts.push(lr);
          }
        });

        payload.appData.records = mergedRecords;
        payload.appData.tasteRecords = mergedTaste;
        payload.appData.stockReceipts = mergedReceipts;

        // Keep local in sync with merged data (skip recursive cloud sync)
        app.data.records = mergedRecords;
        app.data.tasteRecords = mergedTaste;
        app.data.stockReceipts = mergedReceipts;
        app.saveState(true);

        // Save a permanent cloud safety backup snapshot before overwriting
        try {
          const backupEndpoint = `${cleanBaseUrl}/mdm_backups/${this.getCloudKey()}_safety_backup.json`;
          fetch(backupEndpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(existingRemote)
          }).catch(() => {});
        } catch (bErr) {}
      }

      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        this.config.status = 'synced';
        this.config.lastSyncTime = new Date().toISOString();
        this.config.lastError = '';
        this.saveConfig();
        const recCount = Object.keys((app.data && app.data.records) || {}).length;
        if (!isSilent) {
          app.showToast(`☁️ डेटा यशस्वीरित्या Google Cloud वर सेव्ह झाला (${recCount} नोंदी)!`, 'success');
          alert(`☁️ कॉम्प्युटरवरील डेटा (${recCount} दैनंदिन नोंदी व साठा) Google Firebase वर यशस्वीरित्या सेव्ह झाला!\n\nशाळा UDISE: ${currentUdise}\n\nआता तुम्ही मोबाईलवर ॲप उघडून याच UDISE सह "📥 क्लाऊडवरून आणा" बटण दाबू शकता.`);
        }
        return true;
      } else {
        const errorText = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new Error('Firebase Rules लॉक आहेत (401 Permission Denied). कृपया Firebase Console मध्ये Rules मध्ये ".read": true, ".write": true करा.');
        }
        throw new Error(`Firebase Error (${res.status}): ${errorText.substring(0, 80)}`);
      }
    } catch (err) {
      console.warn("Firebase push error:", err);
      this.config.status = 'error';
      this.config.lastError = err.message || 'सिंक त्रुटी';
      this.updateUIStatus();
      if (!isSilent) {
        app.showToast(`⚠️ क्लाऊड सिंक करताना अडचण आली: ${this.config.lastError}`, 'warning');
      }
      return false;
    } finally {
      this.isSyncing = false;
    }
  },

  /**
   * Restore from Cloud Safety Backup if main bucket was ever corrupted or emptied
   */
  async restoreFromCloudBackup() {
    if (!this.config.firebaseUrl) {
      alert('कृपया प्रथम Firebase URL प्रविष्ट करा.');
      return false;
    }
    const cleanBaseUrl = this.config.firebaseUrl.trim().replace(/\/$/, '');
    const backupEndpoint = `${cleanBaseUrl}/mdm_backups/${this.getCloudKey()}_safety_backup.json`;

    try {
      const res = await fetch(backupEndpoint);
      if (res.ok) {
        const json = await res.json();
        if (json && json.appData && json.appData.records) {
          const recCount = Object.keys(json.appData.records).length;
          if (confirm(`सुरक्षित क्लाऊड बॅकअप सापडला (${recCount} नोंदी).\n\nहा डेटा त्वरित रिस्टोअर करायचा का?`)) {
            app.data = Object.assign({}, app.data, json.appData);
            app.saveState();
            app.loadState();
            app.refreshAllViews();
            if (typeof app.onDateChanged === 'function') app.onDateChanged();
            app.renderCurrentTab();
            // Re-push restored data to main bucket
            await this.pushToCloud(true);
            alert(`🎉 ${recCount} नोंदींचा क्लाऊड बॅकअप यशस्वीरित्या रिस्टोअर झाला!`);
            return true;
          }
        }
      }
      alert('क्लाऊडवर कोणताही जुना सुरक्षित बॅकअप सापडला नाही.');
      return false;
    } catch (e) {
      alert('क्लाऊड बॅकअप शोधताना त्रुटी आली: ' + e.message);
      return false;
    }
  },

  /**
   * Pull latest state from Google Firebase Cloud Database
   */
  async pullFromCloud(isSilent = false) {
    if (!this.config.firebaseUrl) return false;

    if (this.isSyncing) return false;
    this.isSyncing = true;

    if (!navigator.onLine) {
      this.isSyncing = false;
      this.config.status = 'offline';
      this.updateUIStatus();
      if (!isSilent) alert('इंटरनेट कनेक्शन बंद आहे. कृपया मोबाईलचे इंटरनेट चालू करा.');
      return false;
    }

    this.config.status = 'syncing';
    this.updateUIStatus();

    const cleanBaseUrl = this.config.firebaseUrl.trim().replace(/\/$/, '');
    const currentUdise = this.getSchoolUdise();
    this.config.schoolCode = currentUdise;
    const endpoint = `${cleanBaseUrl}/mdm_schools/${this.getCloudKey()}.json`;

    try {
      const res = await fetch(endpoint);
      if (res.ok) {
        const json = await res.json();
        if (json && json.appData && typeof json.appData === 'object') {
          const cloudRecords = json.appData.records || {};
          const recordCount = Object.keys(cloudRecords).length;

          // Merge cloud data safely into app.data
          app.data = Object.assign({}, app.data, json.appData);
          
          // Persist to all layers (pass true to avoid recursive cloud auto-sync)
          app.saveState(true);
          app.loadState();
          app.refreshAllViews();
          if (typeof app.onDateChanged === 'function') {
            app.onDateChanged();
          }
          app.renderCurrentTab();

          this.config.status = 'synced';
          this.config.lastSyncTime = json.updatedAt || new Date().toISOString();
          this.config.lastError = '';
          this.saveConfig();

          if (!isSilent) {
            app.showToast(`🎉 Google Cloud वरून ${recordCount} नोंदी यशस्वीरित्या डाऊनलोड झाल्या!`, 'success');
            alert(`🎉 Google Cloud वरून ${recordCount} दैनंदिन नोंदी व साठा यशस्वीरित्या डाऊनलोड झाला!\n\nशाळा UDISE: ${currentUdise}\nमोबाईलवर सर्व डेटा अद्ययावत झाला आहे.`);
          }
          return true;
        } else {
          // Empty remote bucket -> DO NOT OVERWRITE REMOTE WITH LOCAL EMPTY SEED!
          this.config.status = 'idle';
          this.updateUIStatus();
          if (!isSilent) {
            alert(`⚠️ Firebase वर या शाळेचा (UDISE: ${currentUdise}) कोणताही डेटा सापडला नाही!\n\nदुरुस्ती कशी करावी:\n1. प्रथम कॉम्प्युटरवर (PC) ॲप उघडा.\n2. वर "☁️ क्लाऊड सिंक" बटणावर क्लिक करा.\n3. "☁️ आता क्लाऊडवर सेव्ह करा" हे बटण दाबा.\n4. त्यानंतर पुन्हा मोबाईलवर येऊन "📥 क्लाऊडवरून आणा" बटण दाबा.`);
          }
          return false;
        }
      } else {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Firebase Rules लॉक आहेत (401 Permission Denied). कृपया Rules मध्ये ".read": true, ".write": true करा.');
        }
        throw new Error(`Firebase Server returned ${res.status}`);
      }
    } catch (err) {
      console.warn("Firebase pull error:", err);
      this.config.status = 'error';
      this.config.lastError = err.message;
      this.updateUIStatus();
      if (!isSilent) {
        alert(`⚠️ क्लाऊडवरून डेटा आणताना त्रुटी आली:\n${this.config.lastError}`);
      }
      return false;
    } finally {
      this.isSyncing = false;
    }
  },

  /**
   * Test Firebase Database Connection
   */
  async testFirebaseConnection(url, code) {
    if (!url || !url.startsWith('http')) {
      alert('कृपया वैध Firebase Realtime Database URL प्रविष्ट करा (उदा. https://your-project-default-rtdb.firebaseio.com/)');
      return false;
    }

    if (url.includes('console.firebase.google.com')) {
      alert('⚠️ तुम्ही Firebase Console ची लिंक टाकली आहे!\n\nकृपया Realtime Database ची URL टाका.\nउदा. https://your-project-default-rtdb.firebaseio.com/');
      return false;
    }

    const cleanBaseUrl = url.trim().replace(/\/$/, '');
    const testEndpoint = `${cleanBaseUrl}/mdm_schools/test_ping.json`;

    try {
      const res = await fetch(testEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: "ok", timestamp: new Date().toISOString() })
      });

      if (res.ok) {
        alert('✅ अभिनंदन! Google Firebase Cloud Database यशस्वीरित्या कनेक्ट झाला!\n\nआता खालील "💾 सेव्ह करा व सुरू करा" बटण दाबा.');
        return true;
      } else if (res.status === 401 || res.status === 403) {
        alert('⚠️ Firebase परवानगी त्रुटी (Permission Denied - Error 401/403):\n\nतुमच्या Firebase Database चे Rules लॉक आहेत!\n\nदुरुस्ती कशी करावी:\n1. Firebase Console (console.firebase.google.com) उघडा.\n2. डाव्या मेनूत Build -> Realtime Database वर जा.\n3. वरील "Rules" टॅब उघडा.\n4. Rules मध्ये ".read": true, ".write": true टाकून "Publish" करा.');
        return false;
      } else {
        alert(`⚠️ Firebase कनेक्ट होऊ शकले नाही (${res.status}). कृपया Firebase Database URL तपासा.`);
        return false;
      }
    } catch (err) {
      alert(`⚠️ Firebase कनेक्शन त्रुटी: ${err.message}\n\nकृपया इंटरनेट कनेक्शन चालू आहे का आणि Realtime Database ची बरोबर URL टाकली आहे का ते तपासा.`);
      return false;
    }
  },

  /**
   * Setup Cloud Sync settings
   */
  async setupCloudSync(schoolCode, pin, firebaseUrl = '') {
    if (!schoolCode || schoolCode.trim().length < 3) {
      alert('कृपया शाळेचा UDISE क्रमांक प्रविष्ट करा.');
      return false;
    }

    this.config.enabled = true;
    this.config.schoolCode = schoolCode.trim();
    this.config.secretPin = pin ? pin.trim() : 'Ican@123';
    this.config.firebaseUrl = (firebaseUrl || '').trim();
    this.config.autoSync = true;
    this.config.lastError = '';
    this.saveConfig();

    if (this.config.firebaseUrl) {
      await this.pushToCloud(false);
    } else {
      this.updateUIStatus();
      app.showToast('✅ शाळा कोड सेट झाला! आता तुम्ही WhatsApp द्वारे 1-क्लिक डेटा सिंक वापरू शकता.', 'success');
    }
    return true;
  },

  disableCloudSync() {
    this.config.enabled = false;
    this.config.status = 'idle';
    this.config.lastError = '';
    this.saveConfig();
    app.showToast('क्लाऊड सिंक बंद करण्यात आले.', 'info');
  },

  /**
   * Generate 1-Click WhatsApp Full School Data Share Link
   */
  shareFullDataViaWhatsApp() {
    const schoolName = app.data.settings.schoolName || 'शाळा';
    const udise = this.config.schoolCode || app.data.settings.udise || '27240801201';
    
    // Create compact JSON package
    const exportPackage = {
      v: "2.0",
      s: app.data.settings,
      r: app.data.records,
      sr: app.data.stockReceipts,
      ds: app.data.damagedStock,
      is: app.data.initialStock,
      cd: app.data.customDemands,
      fr: app.data.formBRemarks
    };

    const jsonStr = JSON.stringify(exportPackage);
    const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(jsonStr))));
    
    const baseUrl = window.location.href.split('?')[0];
    const directLink = `${baseUrl}?mdm_import=${encoded}`;

    const dNow = new Date();
    const dateStr = String(dNow.getDate()).padStart(2, '0') + '/' + String(dNow.getMonth() + 1).padStart(2, '0') + '/' + dNow.getFullYear();
    const msg = `🍲 *शालेय पोषण आहार दैनिक नोंद प्रणाली*\n\n🏫 *शाळा:* ${schoolName}\n🆔 *UDISE कोड:* ${udise}\n📅 *तारीख:* ${dateStr}\n\n📲 *मोबाईलवर संपूर्ण डेटा 1-क्लिकमध्ये उघडण्यासाठी खालील लिंक दाबा:*\n${directLink}`;
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, '_blank');
  },

  /**
   * Generate 1-Click WhatsApp Today's Daily Entry Share Link
   */
  shareTodayEntryViaWhatsApp(dateStr) {
    const rec = app.data.records[dateStr];
    if (!rec) {
      alert('या दिनांकाची कोणतीही नोंद आढळली नाही.');
      return;
    }

    const schoolName = app.data.settings.schoolName || 'शाळा';
    const jsonStr = JSON.stringify({ d: dateStr, r: rec });
    const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(jsonStr))));
    
    const baseUrl = window.location.href.split('?')[0];
    const updateLink = `${baseUrl}?mdm_daily_entry=${encoded}`;

    const [yr, mo, dy] = dateStr.split('-');
    const msg = `🍲 *MDM दैनिक नोंद अपडेट*\n🏫 *शाळा:* ${schoolName}\n📅 *दिनांक:* ${dy}/${mo}/${yr}\n👥 *हजर विद्यार्थी:* ${rec.children}\n🍛 *मेन्यू:* ${rec.menuName}\n\n💻 *लॅपटॉपवर ही नोंद जोडण्यासाठी खालील लिंक दाबा:*\n${updateLink}`;
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, '_blank');
  },

  formatTimeStr(isoString) {
    if (!isoString) return 'आत्ता';
    const t = new Date(isoString);
    if (isNaN(t.getTime())) return 'आत्ता';
    let hrs = t.getHours();
    const mins = String(t.getMinutes()).padStart(2, '0');
    const ampm = hrs >= 12 ? 'PM' : 'AM';
    hrs = hrs % 12 || 12;
    return `${hrs}:${mins} ${ampm}`;
  },

  /**
   * Update UI badges, header status, and modal
   */
  updateUIStatus() {
    this.config.schoolCode = this.getSchoolUdise();
    const headerPill = document.getElementById('cloudStatusPill');
    const headerText = document.getElementById('cloudStatusText');
    const headerDot = document.getElementById('cloudStatusDot');

    if (!headerPill) return;

    if (!this.config.enabled) {
      headerPill.className = 'meta-pill cloud-pill-disabled';
      if (headerText) headerText.textContent = '☁️ सिंक: ऑफलाईन';
      if (headerDot) headerDot.style.background = '#94a3b8';
    } else if (this.config.status === 'syncing') {
      headerPill.className = 'meta-pill cloud-pill-syncing';
      if (headerText) headerText.textContent = '🔄 सिंक होत आहे...';
      if (headerDot) headerDot.style.background = '#f59e0b';
    } else if (this.config.status === 'synced') {
      headerPill.className = 'meta-pill cloud-pill-synced';
      const timeStr = this.formatTimeStr(this.config.lastSyncTime);
      if (headerText) headerText.textContent = `☁️ क्लाऊड सिंक: चालू (${timeStr})`;
      if (headerDot) headerDot.style.background = '#10b981';
    } else if (this.config.status === 'offline') {
      headerPill.className = 'meta-pill cloud-pill-offline';
      if (headerText) headerText.textContent = '⚠️ सिंक: इंटरनेट नाही';
      if (headerDot) headerDot.style.background = '#ef4444';
    } else {
      headerPill.className = 'meta-pill cloud-pill-error';
      if (headerText) headerText.textContent = '⚠️ सिंक त्रुटी';
      if (headerDot) headerDot.style.background = '#ef4444';
    }

    const statusInModal = document.getElementById('cloudModalStatusText');
    if (statusInModal) {
      if (this.config.enabled) {
        if (this.config.firebaseUrl && this.config.status === 'synced') {
          statusInModal.innerHTML = `<span class="badge badge-success" style="font-size: 0.9rem;">✅ Google Firebase क्लाऊड सिंक सक्रिय</span> (शाळा: <code>${this.config.schoolCode}</code>) <br><small class="text-success">शेवटचा सिंक: ${this.formatTimeStr(this.config.lastSyncTime)}</small>`;
        } else if (this.config.status === 'error') {
          statusInModal.innerHTML = `<span class="badge badge-danger" style="font-size: 0.9rem;">⚠️ त्रुटी: ${this.config.lastError || 'कनेक्शन अयशस्वी'}</span>`;
        } else {
          statusInModal.innerHTML = `<span class="badge badge-success" style="font-size: 0.9rem;">✅ WhatsApp 1-क्लिक सिंक सक्रिय</span> (शाळा: <code>${this.config.schoolCode}</code>)`;
        }
      } else {
        statusInModal.innerHTML = `<span class="badge badge-secondary" style="font-size: 0.9rem;">❌ सिंक बंद आहे (डेटा फक्त या डिव्हाइसवर सुरक्षित आहे)</span>`;
      }
    }
  }
};
