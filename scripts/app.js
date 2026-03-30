        let refreshing = false;

        // Monitor the Service Worker for updates
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (refreshing) return;
                refreshing = true;
                // This line actually reloads the page for you!
                window.location.reload();
            });
        }
        // --- APP VERSION ---
        const APP_VERSION = "v2026.03.30.2122";
        // --- ENCRYPTED DATABASE LOGIC ---
        const PBKDF2_ITERATIONS = 100000;

        async function decryptDatabase(password) {
            const resp = await fetch('./scripts/database.enc?v=' + APP_VERSION);
            const b64 = await resp.text();
            const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

            const salt = raw.slice(0, 16);
            const iv = raw.slice(16, 28);
            const ciphertext = raw.slice(28);

            const keyMaterial = await crypto.subtle.importKey(
                'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
            );
            const key = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['decrypt']
            );
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            const code = new TextDecoder().decode(decrypted);
            new Function(code)();
        }

        async function bootWithPassword(password, silent) {
            try {
                await decryptDatabase(password);
                sessionStorage.setItem('gomu_key', password);
                localStorage.setItem('gomu_auth_passed', 'true');
                if (!silent) {
                    const loginScreen = document.getElementById('login-screen');
                    loginScreen.style.transition = 'opacity 0.4s ease';
                    loginScreen.style.opacity = '0';
                    setTimeout(() => { loginScreen.style.display = 'none'; }, 400);
                } else {
                    document.getElementById('login-screen').style.display = 'none';
                }
                await initApp();
            } catch (e) {
                if (silent) {
                    // sessionStorage key is stale/wrong — show login
                    sessionStorage.removeItem('gomu_key');
                    localStorage.removeItem('gomu_auth_passed');
                    document.getElementById('login-screen').style.display = '';
                } else {
                    const errorText = document.getElementById('login-error');
                    const card = document.getElementById('login-card');
                    errorText.style.display = 'block';
                    card.style.transform = 'translateX(-10px)';
                    setTimeout(() => card.style.transform = 'translateX(10px)', 50);
                    setTimeout(() => card.style.transform = 'translateX(-10px)', 100);
                    setTimeout(() => card.style.transform = 'translateX(10px)', 150);
                    setTimeout(() => card.style.transform = 'translateX(0)', 200);
                }
            }
        }

        window.checkLogin = function() {
            const input = document.getElementById('login-password').value;
            bootWithPassword(input, false);
        };

        // --- INDEXED DB ENGINE (Unlimited Storage) ---
        const DB_NAME = 'GomuTrainerDB';
        const STORE_NAME = 'appData';
        let workoutHistoryCache = []; // Lightning-fast synchronous memory cache

        function initDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = (e) => {
                    if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                        e.target.result.createObjectStore(STORE_NAME);
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        async function setDB(key, value) {
            const db = await initDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async function getDB(key, fallback = null) {
            const db = await initDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const request = tx.objectStore(STORE_NAME).get(key);
                request.onsuccess = () => resolve(request.result !== undefined ? request.result : fallback);
                request.onerror = () => reject(request.error);
            });
        }

        async function bootDatabase() {
            let dbHistory = await getDB('workoutHistory');
            // Migration: Move old localStorage data to IndexedDB
            if (!dbHistory) {
                const legacy = localStorage.getItem('workoutHistory');
                if (legacy) {
                    dbHistory = JSON.parse(legacy);
                    await setDB('workoutHistory', dbHistory);
                    localStorage.removeItem('workoutHistory'); 
                } else {
                    dbHistory = [];
                }
            }
            workoutHistoryCache = dbHistory;
        }

        // --- UPDATED SAFEPARSE (Hijacks history reads to use memory cache) ---
        function safeParse(key, fallback) {
            if (key === 'workoutHistory') return workoutHistoryCache;
            
            try {
                const item = localStorage.getItem(key);
                if (!item) return fallback;
                const parsed = JSON.parse(item);
                return parsed !== null ? parsed : fallback;
            } catch (e) {
                console.error(`Memory cleared for ${key} due to corruption.`);
                return fallback;
            }
        }

        let currentProgram = null;
        let selectedWeek = null;
        let selectedDay = null;
        let activeWorkout = safeParse('activeWorkout', null);
        let completedDays = safeParse('completedDays', {});

        let timerInterval;
        let timeLeft = 0;
        let timerTargetMs = 0;

        let workoutDurationInterval;

        // NEW: Background Web Worker to prevent mobile browsers from pausing the timer
        const workerCode = `
            let interval;
            self.onmessage = function(e) {
                if (e.data === 'start') {
                    clearInterval(interval);
                    interval = setInterval(() => self.postMessage('tick'), 1000);
                } else if (e.data === 'stop') {
                    clearInterval(interval);
                }
            };
        `;
        const timerWorker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));

        // --- NEW: REGISTER THE BACKGROUND SERVICE WORKER ---
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                // Since sw.js is in the root, the path is just './sw.js'
                navigator.serviceWorker.register('./sw.js')
                    .then(reg => console.log('Service Worker registered at root!'))
                    .catch(err => console.log('SW registration failed:', err));
            });
        }

        // Handle when the user swipes to the home screen and comes back
        // Handle when the user swipes to the home screen and comes back
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                // 1. Re-acquire the screen wake lock
                if (typeof activeWorkout !== 'undefined' && activeWorkout) requestWakeLock();
                
                // 2. Clear any stuck OS notifications instantly
                if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.ready.then(function(reg) {
                        reg.getNotifications({tag: 'gomu-timer'}).then(function(notifications) {
                            notifications.forEach(n => n.close());
                        });
                    });
                }

                // 3. Catch up the timer!
                const banner = document.getElementById('rest-timer-banner');
                if (banner && banner.classList.contains('active') && !banner.classList.contains('finished')) {
                    timeLeft = Math.round((timerTargetMs - Date.now()) / 1000);
                    updateTimerDisplay();
                    
                    if (timeLeft <= 0) {
                        timerWorker.postMessage('stop');
                        playBeep(); // Play the sound the exact second they open the app
                        completeTimer(); 
                    }
                }
            }
        });

        // MODAL FUNCTIONS
        window.openCustomTimerModal = function() {
            const modal = document.getElementById('custom-timer-modal');
            const card = modal.querySelector('.modal-card');
            const fab = document.querySelector('.global-timer-fab');
            
            document.getElementById('custom-timer-input').value = '';
            modal.style.display = 'flex';
            
            // Safety Check: Only animate from the FAB if it actually exists on screen!
            if (fab && fab.offsetWidth > 0) {
                const fabRect = fab.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();
                const deltaX = (fabRect.left + fabRect.width/2) - (cardRect.left + cardRect.width/2);
                const deltaY = (fabRect.top + fabRect.height/2) - (cardRect.top + cardRect.height/2);
                
                card.animate([
                    { transform: `translate(${deltaX}px, ${deltaY}px) scale(0.1)`, opacity: 0, borderRadius: '50px' },
                    { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '20px' }
                ], { duration: 250, easing: 'ease-out' });
            } else {
                // Standard Pop-in Fallback
                card.animate([
                    { transform: 'scale(0.8)', opacity: 0 },
                    { transform: 'scale(1)', opacity: 1 }
                ], { duration: 200, easing: 'ease-out' });
            }
        };

        window.closeCustomTimerModal = function() {
            const modal = document.getElementById('custom-timer-modal');
            const card = modal.querySelector('.modal-card');
            const fab = document.querySelector('.global-timer-fab');
            
            if (fab && fab.offsetWidth > 0) {
                const fabRect = fab.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();
                const deltaX = (fabRect.left + fabRect.width/2) - (cardRect.left + cardRect.width/2);
                const deltaY = (fabRect.top + fabRect.height/2) - (cardRect.top + cardRect.height/2);
                
                card.animate([
                    { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '20px' },
                    { transform: `translate(${deltaX}px, ${deltaY}px) scale(0.1)`, opacity: 0, borderRadius: '50px' }
                ], { duration: 200, easing: 'ease-in' });
            } else {
                card.animate([
                    { transform: 'scale(1)', opacity: 1 },
                    { transform: 'scale(0.8)', opacity: 0 }
                ], { duration: 150, easing: 'ease-in' });
            }
            
            // Absolute failsafe to ensure the black screen ALWAYS disappears
            setTimeout(() => {
                modal.style.display = 'none';
            }, 190);
        };

        window.submitCustomTimer = function() {
            const val = parseFloat(document.getElementById('custom-timer-input').value);
            if (!isNaN(val) && val > 0) {
                startTimer(Math.round(val * 60));
                closeCustomTimerModal();
            }
        };

        function startWorkoutTimer() {
            clearInterval(workoutDurationInterval);
            const timerEl = document.getElementById('workout-duration');
            if (!timerEl) return;

            if (activeWorkout) {
                // Retroactive fix: if you had a workout active before the update, give it a start time NOW
                if (!activeWorkout.startTime) {
                    activeWorkout.startTime = Date.now();
                    localStorage.setItem('activeWorkout', JSON.stringify(activeWorkout));
                }
                
                timerEl.style.display = 'block';

                const updateTimer = () => {
                    const diffMs = Date.now() - activeWorkout.startTime;
                    const totalSecs = Math.floor(diffMs / 1000);
                    const h = Math.floor(totalSecs / 3600);
                    const m = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, '0');
                    const s = (totalSecs % 60).toString().padStart(2, '0');
                    timerEl.innerText = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
                };

                updateTimer(); 
                workoutDurationInterval = setInterval(updateTimer, 1000);
            } else {
                timerEl.style.display = 'none';
            }
        }

        function showConfirm(title, message, confirmText = 'Confirm', cancelText = 'Cancel', isDangerous = false) {
            return new Promise((resolve) => {
                const modal = document.getElementById('confirm-modal');
                const titleEl = document.getElementById('confirm-title');
                const msgEl = document.getElementById('confirm-message');
                const confirmBtn = document.getElementById('confirm-ok');
                const cancelBtn = document.getElementById('confirm-cancel');

                titleEl.innerText = title;
                msgEl.innerText = message;
                confirmBtn.innerText = confirmText;
                cancelBtn.innerText = cancelText;

                confirmBtn.className = 'modal-btn confirm';
                if (isDangerous) confirmBtn.classList.add('danger');

                modal.style.display = 'flex';

                const onConfirm = () => { cleanup(); resolve(true); };
                const onCancel = () => { cleanup(); resolve(false); };

                const cleanup = () => {
                    modal.style.display = 'none';
                    confirmBtn.removeEventListener('click', onConfirm);
                    cancelBtn.removeEventListener('click', onCancel);
                };

                confirmBtn.addEventListener('click', onConfirm);
                cancelBtn.addEventListener('click', onCancel);
            });
        }

        async function initApp() {
            await bootDatabase(); // CRITICAL: Wait for history to load into memory

            // Update version display
            const versionEl = document.getElementById('app-version-text');
            if (versionEl) versionEl.innerText = APP_VERSION;

            const savedProgram = localStorage.getItem('activeProgram');
            if (savedProgram && db[savedProgram]) {
                currentProgram = savedProgram;
                if(activeWorkout && activeWorkout.program === savedProgram) {
                    selectedWeek = activeWorkout.week;
                    selectedDay = activeWorkout.day;
                } else {
                    const wks = Object.keys(db[currentProgram].weeks).sort((a,b) => a - b);
                    if(wks.length > 0) {
                        selectedWeek = wks[0];
                        const dys = Object.keys(db[currentProgram].weeks[selectedWeek]).sort((a,b) => a - b);
                        selectedDay = dys[0];
                    }
                }
            }
            updateDashboard(); 
            updateLibraryUI();
            checkOnboarding();
        }

        function buildSetRow(params) {
            const { 
                s, rowId, exId, exName, isMain, block, 
                repsValue, rpeValue, loadValue, isChecked, 
                smartDefaultLoad, restSeconds 
            } = params;

            const disabledAttr = isChecked ? 'disabled' : '';
            const repsClass = 'input-box saveable calc-trigger';
            const rpeClass = 'input-box input-rpe saveable calc-trigger';
            const loadClass = `input-box saveable calc-trigger ${isMain ? 'main-load' : 'acc-load'}`;
            
            // Calculate initial plates if there's a load value
            const initialPlates = getPlateString(parseFloat(loadValue) || parseFloat(smartDefaultLoad));

            let e1rmCell = '';
            if (isMain) {
                e1rmCell = `<span><button class="e1rm-btn" id="e1rm-btn-${rowId}" data-exid="${exId}" data-exname="${exName}" data-rowid="${rowId}" data-e1rm="0"><span class="e1rm-label">Calc</span><span class="e1rm-value">--</span></button></span>`;
            }

            return `
            <div class="set-row" style="${!isMain ? 'grid-template-columns: 0.8fr 1fr 1.2fr 1.5fr 1.6fr 0.8fr;' : ''}">
                <span>${s}</span>
                <span><input type="number" id="${rowId}_reps" class="${repsClass}" data-rowid="${rowId}" value="${repsValue}" inputmode="numeric" ${disabledAttr}></span>
                <span><input type="number" id="${rowId}_rpe" class="${rpeClass}" data-rowid="${rowId}" value="${rpeValue}" step="0.5" inputmode="decimal" ${disabledAttr}></span>
                <span style="display:flex; flex-direction:column; gap:4px; align-items:center;">
                    <input type="number" id="${rowId}_load" class="${loadClass}" data-rowid="${rowId}" data-pct="${block.pct || ''}" data-exname="${exName}" data-exid="${exId}" value="${loadValue}" placeholder="kg" inputmode="decimal" ${disabledAttr}>
                    <div id="${rowId}_plates" style="font-size: 9px; color: var(--text-muted); font-weight: 800; letter-spacing: 0.5px;">${initialPlates}</div>
                </span>
                ${e1rmCell}
                <span class="check-circle ${isChecked}" id="${rowId}_check" data-rest="${restSeconds}" onclick="toggleCheck(this)"></span>
            </div>
            `;
        }

        const TAB_ORDER = ['library-screen', 'home-screen', 'history-screen'];
        function switchTab(tabId) {
            const currentScreen = document.querySelector('.app-screen.active');
            const fromIdx = TAB_ORDER.indexOf(currentScreen?.id ?? '');
            const toIdx   = TAB_ORDER.indexOf(tabId);
            const slideLeft = fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx;

            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active', 'slide-left'));
            document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));

            const next = document.getElementById(tabId);
            next.classList.add('active');
            if (slideLeft) next.classList.add('slide-left');
            
            if(tabId === 'home-screen') {
                document.getElementById('nav-home').classList.add('active');
                updateDashboard();
            }
            if(tabId === 'library-screen') {
                document.getElementById('nav-library').classList.add('active');
                updateLibraryUI();
            }
            if(tabId === 'history-screen') {
                document.getElementById('nav-history').classList.add('active');
                window.historyDisplayLimit = 3; // NEW: Reset the list to 3 items when entering the tab
                renderHistory();
                if (typeof initChartSelect === 'function') initChartSelect(); 
            }
            if(tabId === 'stats-screen') renderStats(); 
            
            updateBanners();
        }
        // Data management bottom sheet
        window.openDataSheet = function() {
            const overlay = document.getElementById('data-sheet-overlay');
            const sheet = document.getElementById('data-sheet');
            overlay.style.display = 'block';
            sheet.style.display = 'block';
            requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)'; });
        };
        window.closeDataSheet = function() {
            const sheet = document.getElementById('data-sheet');
            sheet.style.transform = 'translateY(100%)';
            setTimeout(() => {
                document.getElementById('data-sheet-overlay').style.display = 'none';
                sheet.style.display = 'none';
            }, 300);
        };

        // Swipe navigation between main tabs
        (function() {
            const TABS = ['library-screen', 'home-screen', 'history-screen'];
            const WORKOUT_SCREENS = new Set(['workout-screen', 'stats-screen', 'summary-screen']);
            let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
            document.addEventListener('touchstart', function(e) {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                touchStartTime = Date.now();
            }, { passive: true });
            document.addEventListener('touchend', function(e) {
                const dx = e.changedTouches[0].clientX - touchStartX;
                const dy = e.changedTouches[0].clientY - touchStartY;
                const dt = Date.now() - touchStartTime;
                if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.8 || dt > 400) return;
                const active = document.querySelector('.app-screen.active');
                if (!active || WORKOUT_SCREENS.has(active.id)) return;
                const idx = TABS.indexOf(active.id);
                if (idx === -1) return;
                if (dx < 0 && idx < TABS.length - 1) switchTab(TABS[idx + 1]);
                if (dx > 0 && idx > 0) switchTab(TABS[idx - 1]);
            }, { passive: true });
        })();

        function updateLibraryUI() {
            const mainProgram = localStorage.getItem('activeProgram'); 
            
            // NEW: Inject Custom Programs dynamically
            const customFolderContent = document.getElementById('custom-folder-content');
            if (customFolderContent) {
                const customProgs = safeParse('customPrograms', {});
                let html = `<button class="action-btn btn-start" style="padding: 12px; margin-bottom: 15px; font-size: 14px; border-style: dashed;" onclick="startCustomWorkout()">+ Start Empty Workout</button>`;
                
                Object.keys(customProgs).forEach(pid => {
                    html += `
                    <div class="program-card" data-program-id="${pid}" onclick="startProgram('${pid}')" style="cursor: pointer;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <h3 class="program-title" style="margin: 0;">${customProgs[pid].name}</h3>
                            <button onclick="event.stopPropagation(); deleteCustomProgram('${pid}')" style="background: rgba(239, 68, 68, 0.1); color: var(--danger); border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; transition: 0.2s;">🗑️</button>
                        </div>
                        <p class="program-desc" style="margin: 0;">Custom Template</p>
                    </div>`;
                });
                customFolderContent.innerHTML = html;
            }

            const isProgramFinished = (pid) => {
                if (!db[pid] || !db[pid].weeks) return false;
                let total = 0, completed = 0;
                Object.keys(db[pid].weeks).forEach(w => {
                    Object.keys(db[pid].weeks[w]).forEach(d => {
                        total++;
                        if (completedDays[`${pid}_w${w}_d${d}`]) completed++;
                    });
                });
                return total > 0 && total === completed;
            };

            document.querySelectorAll('#library-screen .program-card').forEach(card => {
                const pid = card.dataset.programId;
                if (!pid) return; // Safety check
                
                const title = card.querySelector('.program-title');
                if (!title) return;
                
                // Cleanup old dynamic elements so they don't duplicate on re-renders
                const existingBadge = title.querySelector('.active-badge');
                if (existingBadge) existingBadge.remove();

                const existingOverview = card.querySelector('.program-overview-ui');
                if (existingOverview) existingOverview.remove();

                if (pid === mainProgram && !isProgramFinished(pid)) {
                    card.style.borderColor = 'var(--accent)';
                    title.innerHTML += ' <span class="active-badge" style="color: var(--accent); font-size: 11px; font-weight: 800; vertical-align: top; margin-left: 6px; padding: 2px 6px; background: rgba(249, 115, 22, 0.1); border-radius: 4px;">ACTIVE</span>';
                    
                    // --- NEW: INJECT QUICK OVERVIEW UI ---
                    if (db[pid] && db[pid].weeks) {
                        let totalDays = 0;
                        let doneDays = 0;
                        let nextW = null, nextD = null;
                        
                        const weeks = Object.keys(db[pid].weeks).sort((a,b) => a - b);
                        for (let w of weeks) {
                            const days = Object.keys(db[pid].weeks[w]).sort((a,b) => a - b);
                            for (let d of days) {
                                totalDays++;
                                if (completedDays[`${pid}_w${w}_d${d}`]) {
                                    doneDays++;
                                } else if (!nextW) {
                                    nextW = w;
                                    nextD = d;
                                }
                            }
                        }
                        
                        const pct = totalDays > 0 ? Math.round((doneDays / totalDays) * 100) : 0;
                        
                        const overviewHtml = `
                        <div class="program-overview-ui" style="margin-top: 15px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.1);">
                            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">
                                <span>Program Progress</span>
                                <span style="color: var(--accent);">${pct}%</span>
                            </div>
                            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.5); border-radius: 3px; overflow: hidden; margin-bottom: 10px;">
                                <div style="width: ${pct}%; height: 100%; background: var(--accent); border-radius: 3px;"></div>
                            </div>
                            <div style="display: flex; justify-content: space-between; font-size: 12px;">
                                <div><span style="color: var(--text-muted);">Up Next:</span> <span style="font-weight: 800; color: #fff;">W${nextW || '-'} D${nextD || '-'}</span></div>
                                <div><span style="color: var(--text-muted);">Completed:</span> <span style="font-weight: 800; color: #fff;">${doneDays} / ${totalDays}</span></div>
                            </div>
                        </div>`;
                        
                        // Drop it directly into the bottom of the active card
                        card.insertAdjacentHTML('beforeend', overviewHtml);
                    }
                    
                } else {
                    card.style.borderColor = 'var(--border)';
                }
            });
        }

        window.updateBodyweight = function(val) {
            let bw = parseFloat(val);
            if (!isNaN(bw) && bw > 0) {
                localStorage.setItem('userBodyweight', bw);
                const bwHist = safeParse('bwHistory', []);
                const today = new Date().toISOString().split('T')[0];
                const filtered = bwHist.filter(e => e.d !== today);
                filtered.push({ d: today, w: bw, ts: Date.now() });
                localStorage.setItem('bwHistory', JSON.stringify(filtered));
            } else {
                localStorage.removeItem('userBodyweight');
            }
            renderStats();
        };

        window.updateGender = function(val) {
            localStorage.setItem('userGender', val);
            renderStats();
        };

        window.calculateDOTS = function(bw, total, gender) {
            if (!bw || !total || bw <= 0 || total <= 0) return 0;
            // Official IPF DOTS Coefficients
            const A = gender === 'M' ? -307.47501 : -57.96288;
            const B = gender === 'M' ? 24.0900756 : 13.6175032;
            const C = gender === 'M' ? -0.1918759221 : -0.1126655495;
            const D = gender === 'M' ? 0.0007391293 : 0.0005158568;
            const E = gender === 'M' ? -0.000001093 : -0.0000010706;
            
            const denominator = A + (B * bw) + (C * Math.pow(bw, 2)) + (D * Math.pow(bw, 3)) + (E * Math.pow(bw, 4));
            return parseFloat(((total * 500) / denominator).toFixed(2));
        };

        window.showPRToast = function(exName, weight, reps) {
            const toast = document.getElementById('pr-toast-container');
            const desc = document.getElementById('pr-toast-desc');
            if (!toast || !desc) return;
            
            desc.innerText = `${exName}: ${weight}kg x ${reps}`;
            toast.classList.add('show');
            if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]); // Special PR Rumble
            
            setTimeout(() => toast.classList.remove('show'), 4000);
        };

        window.isNoPlateExercise = function(name) {
            if (!name) return false;
            return /dumbbell|dumbell|\bdb\b|cable|machine/i.test(name);
        };

        window.isBodyweightExercise = function(name) {
            if (!name) return false;
            return /pull[-\s]?up|chin[-\s]?up|dip/i.test(name);
        };

        window.getEquipmentMode = function(exName) {
            const modes = safeParse('equipmentModes', {});
            if (modes[exName]) return modes[exName];
            // Auto-detect default from exercise name
            if (/dumbbell|dumbell|\bdb\b/i.test(exName)) return '1db';
            if (/cable|machine|pulldown|lat pull|tricep push|face pull/i.test(exName)) return 'cable';
            return 'bb';
        };

        window.setEquipmentMode = function(exName, mode) {
            const modes = safeParse('equipmentModes', {});
            modes[exName] = mode;
            localStorage.setItem('equipmentModes', JSON.stringify(modes));
            renderWorkout();
        };

        window.cycleEquipmentMode = function(exName) {
            const order = ['bb', '1db', '2db', 'cable'];
            const current = getEquipmentMode(exName);
            const next = order[(order.indexOf(current) + 1) % order.length];
            setEquipmentMode(exName, next);
        };

        window.roundForEquipment = function(weight, exName) {
            const mode = getEquipmentMode(exName);
            switch (mode) {
                case '1db':  return Math.round(weight / 2) * 2;
                case '2db':  return Math.round(weight / 4) * 4;
                case 'cable': return parseFloat(weight.toFixed(1));
                default:     return Math.round(weight / 2.5) * 2.5;
            }
        };

        function updateDashboard() {
            const heroEmpty = document.getElementById('hero-empty');
            const heroResume = document.getElementById('hero-resume');
            
            const progContainer = document.getElementById('dash-progress-container');
            const progFill = document.getElementById('dash-progress-fill');
            const progText = document.getElementById('dash-progress-text');

            // The True Active Program
            let mainProgram = localStorage.getItem('activeProgram');
            if (activeWorkout && activeWorkout.program) {
                mainProgram = activeWorkout.program;
            }

            // --- PROGRESS BAR LOGIC ---
            if (mainProgram && db[mainProgram] && !mainProgram.startsWith('Custom_')) {
                let totalDays = 0;
                let doneDays = 0;
                Object.keys(db[mainProgram].weeks).forEach(w => {
                    Object.keys(db[mainProgram].weeks[w]).forEach(d => {
                        totalDays++;
                        if (completedDays[`${mainProgram}_w${w}_d${d}`]) doneDays++;
                    });
                });
                
                if (totalDays > 0) {
                    progContainer.style.display = 'block';
                    progText.innerText = `${doneDays}/${totalDays} Workouts`;
                    const track = progFill ? progFill.parentElement : progContainer.querySelector('.progress-track');
                    if (track) track.innerHTML = Array.from({length: totalDays}, (_, i) =>
                        `<div class="p-dot${i < doneDays ? ' done' : ''}"></div>`).join('');
                    
                    // --- NEW: INTERACTIVE QUICK OVERVIEW ---
                    progContainer.style.cursor = 'pointer';
                    progContainer.onclick = window.openProgramOverview;
                    
                    // Safely rename "CURRENT BLOCK" to "CURRENT PROGRAM"
                    progContainer.querySelectorAll('*').forEach(el => {
                        el.childNodes.forEach(child => {
                            if (child.nodeType === Node.TEXT_NODE && child.nodeValue.includes('CURRENT BLOCK')) {
                                child.nodeValue = child.nodeValue.replace('CURRENT BLOCK', 'CURRENT PROGRAM');
                            }
                        });
                    });

                } else {
                    progContainer.style.display = 'none';
                }
            } else {
                progContainer.style.display = 'none';
            }

            // --- HERO CARD LOGIC ---
            if (mainProgram && !activeWorkout && db[mainProgram] && !mainProgram.startsWith('Custom_')) {
                let nextW = null, nextD = null;
                const weeks = Object.keys(db[mainProgram].weeks).sort((a,b) => a - b);
                for (let w of weeks) {
                    const days = Object.keys(db[mainProgram].weeks[w]).sort((a,b) => a - b);
                    for (let d of days) {
                        if (!completedDays[`${mainProgram}_w${w}_d${d}`]) {
                            nextW = w;
                            nextD = d;
                            break;
                        }
                    }
                    if (nextW) break;
                }
                
                heroEmpty.style.display = 'none';
                heroResume.style.display = 'block';
                heroResume.classList.add('active-state'); 
                heroResume.style.borderColor = 'var(--teal)';
                heroResume.querySelector('span').innerText = 'UP NEXT';
                heroResume.querySelector('span').style.color = 'var(--teal)';
                document.getElementById('hero-program-name').innerText = db[mainProgram].name;
                
                const btn = heroResume.querySelector('.hero-btn');
                
                if (nextW && nextD) {
                    document.getElementById('hero-program-detail').innerText = `Week ${nextW} • Day ${nextD}`;
                    btn.innerText = 'Go to Next Workout';
                    btn.style.background = 'var(--teal)';
                    btn.style.color = '#000';
                    
                    heroResume.onclick = () => {
                        currentProgram = mainProgram; // Sync viewed program
                        selectedWeek = nextW;
                        selectedDay = nextD;
                        updateLibraryUI();
                        renderWeekPills();
                        renderDayPills();
                        document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
                        document.getElementById('workout-screen').classList.add('active');
                        renderWorkout();
                        
                        // FIX: Scroll to top for fresh workouts so you see the Warm-Up routine!
                        setTimeout(() => {
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                        }, 150);
                    };
                } else {
                    document.getElementById('hero-program-detail').innerText = `Program Completed 🏆`;
                    btn.innerText = 'Restart Program';
                    btn.style.background = 'var(--teal)';
                    btn.style.color = '#000';
                    
                    heroResume.onclick = () => {
                        currentProgram = mainProgram;
                        clearCurrentProgram(); 
                    };
                }
                
            } else if (activeWorkout && db[activeWorkout.program]) {
                heroEmpty.style.display = 'none';
                heroResume.style.display = 'block';
                heroResume.classList.add('active-state');
                heroResume.style.borderColor = 'var(--accent)';
                heroResume.querySelector('span').innerText = 'IN PROGRESS';
                heroResume.querySelector('span').style.color = 'var(--accent)';
                document.getElementById('hero-program-name').innerText = db[activeWorkout.program].name;
                document.getElementById('hero-program-detail').innerText = `Week ${activeWorkout.week} • Day ${activeWorkout.day}`;
                const btn = heroResume.querySelector('.hero-btn');
                btn.innerText = 'Resume Workout';
                btn.style.background = 'var(--accent)';
                btn.style.color = '#000';
                
                heroResume.onclick = () => resumeWorkout();
            } else {
                heroResume.style.display = 'none';
                heroEmpty.style.display = 'block';
                updateLibraryUI();
            }

            updateAnalytics();
        }

        function checkOnboarding() {
            let saved1RMs = safeParse('global1RMs', {});
            if (!saved1RMs['Squat'] || !saved1RMs['Bench Press'] || !saved1RMs['Deadlift']) {
                document.getElementById('ob-sq').value = '';
                document.getElementById('ob-bp').value = '';
                document.getElementById('ob-dl').value = '';
                document.getElementById('onboarding-modal').style.display = 'flex';
            }
        }

        function saveOnboarding() {
            let sq = parseFloat(document.getElementById('ob-sq').value);
            let bp = parseFloat(document.getElementById('ob-bp').value);
            let dl = parseFloat(document.getElementById('ob-dl').value);
            
            let saved1RMs = safeParse('global1RMs', {});
            if(sq) saved1RMs['Squat'] = sq;
            if(bp) saved1RMs['Bench Press'] = bp;
            if(dl) saved1RMs['Deadlift'] = dl;
            
            localStorage.setItem('global1RMs', JSON.stringify(saved1RMs));
            document.getElementById('onboarding-modal').style.display = 'none';
            updateDashboard(); 
        }

        window.normalizeExName = function(name) {
            if (!name) return name;
            const lower = name.toLowerCase().trim();
            // Automatically merges aliases into the core "Big 3" names
            if (lower === 'bench' || lower === 'bench press' || lower === 'bench press (barbell)') return 'Bench Press';
            if (lower === 'squat' || lower === 'squat (barbell)') return 'Squat';
            if (lower === 'deadlift' || lower === 'deadlift (barbell)') return 'Deadlift';
            return name;
        };

        function getResolved1RM(exName) {
            let saved1RMs = safeParse('global1RMs', {});
            const normName = normalizeExName(exName);
            if (saved1RMs[normName]) return saved1RMs[normName];
            
            const lowerName = normName.toLowerCase();
            if (lowerName.includes('squat')) return saved1RMs['Squat'] || 0;
            if (lowerName.includes('bench')) return saved1RMs['Bench Press'] || 0;
            if (lowerName.includes('deadlift')) return saved1RMs['Deadlift'] || 0;
            
            return 0;
        }

        function startProgram(programId) {
            const programWeeks = Object.keys(db[programId].weeks).sort((a,b) => a - b);
            
            if (programWeeks.length === 0) {
                alert("⚠️ This program hasn't been injected with data yet! Run your Python script first.");
                return;
            }

            currentProgram = programId;
            // Removed the localStorage overwrite here!
            
            if (!selectedWeek || !programWeeks.includes(selectedWeek)) {
                selectedWeek = programWeeks[0];
                selectedDay = null; 
            }
            
            updateLibraryUI();
            renderWeekPills();
            renderDayPills();
            
            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
            document.getElementById('workout-screen').classList.add('active');
            
            renderWorkout();
            updateBanners();
        }

        function renderWeekPills() {
            const programWeeks = Object.keys(db[currentProgram].weeks).sort((a,b) => a - b);
            const wContainer = document.getElementById('week-pills');
            
            wContainer.innerHTML = programWeeks.map(w => {
                const daysInWeek = Object.keys(db[currentProgram].weeks[w] || {});
                let allCompleted = false;
                
                if (daysInWeek.length > 0) {
                    allCompleted = daysInWeek.every(d => {
                        const dKey = `${currentProgram}_w${w}_d${d}`;
                        return completedDays[dKey] === true;
                    });
                }
                
                // Determine the exact classes for the pill
                let classes = 'pill';
                if (w === selectedWeek) classes += ' active';
                if (allCompleted) classes += ' completed';
                
                return `<div class="${classes}" onclick="selectWeek('${w}')">Week ${w}</div>`;
            }).join('');
        }
        
        function selectWeek(w) {
            selectedWeek = w;
            selectedDay = null; 
            renderWeekPills();
            renderDayPills();
            renderWorkout();
        }
		
        function renderDayPills() {
            const days = Object.keys(db[currentProgram]?.weeks[selectedWeek] || {}).sort((a,b) => a - b);
            if (!selectedDay || !days.includes(selectedDay)) {
                selectedDay = days.length > 0 ? days[0] : null;
            }
            
            const dContainer = document.getElementById('day-pills');
            dContainer.innerHTML = days.map(d => {
                const dKey = `${currentProgram}_w${selectedWeek}_d${d}`;
                const isCompleted = completedDays[dKey];
                const isAct = (activeWorkout && activeWorkout.key === dKey);
                
                // Determine the exact classes for the day pill
                let classes = 'pill';
                if (d === selectedDay) classes += ' active';
                if (isCompleted) classes += ' completed';
                
                let icon = '';
                // We remove the text checkmark since the green border handles it, 
                // but keep the orange dot if a workout is currently in progress
                if (isAct && !isCompleted) icon = `<span class="pill-icon indicator-active">●</span>`;
                
                return `<div class="${classes}" onclick="selectDay('${d}')">Day ${d} ${icon}</div>`;
            }).join('');
        }

        function selectDay(d) {
            selectedDay = d;
            renderDayPills();
            renderWorkout();
        }

        function updateBanners() {
            const banner = document.getElementById('floating-banner');
            const currentTabId = document.querySelector('.app-screen.active').id;
            
            // ZOMBIE CHECK: Added db[activeWorkout.program] to ensure we only show banners for completely valid programs
            if (activeWorkout && db[activeWorkout.program] && currentTabId !== 'workout-screen' && currentTabId !== 'home-screen' && currentTabId !== 'summary-screen') {
                const pName = db[activeWorkout.program].name;
                
                banner.innerHTML = `
                    <div style="display:flex; align-items:center; flex:1; overflow: hidden;">
                        <div class="fb-icon">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        </div>
                        <div class="fb-text">
                            <div class="fb-title">Workout in Progress</div>
                            <div class="fb-subtitle">${pName} • W${activeWorkout.week} D${activeWorkout.day}</div>
                        </div>
                    </div>
                    <div class="fb-action">Resume</div>
                `;
                banner.style.display = 'flex'; 
            } else {
                banner.style.display = 'none';
            }
        }

        function resumeWorkout() {
            if (!activeWorkout) return;
            
            // NEW: Zombie Killer - If the program memory is corrupted or missing, silently destroy it and abort!
            if (!db[activeWorkout.program]) {
                activeWorkout = null;
                localStorage.removeItem('activeWorkout');
                updateBanners();
                updateDashboard();
                return;
            }

            currentProgram = activeWorkout.program;
            if (!currentProgram.startsWith('Custom_')) {
                localStorage.setItem('activeProgram', currentProgram);
            }
            
            selectedWeek = activeWorkout.week;
            selectedDay = activeWorkout.day;
            
            updateLibraryUI();
            renderWeekPills();
            renderDayPills();
            
            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
            document.getElementById('workout-screen').classList.add('active');
            
            renderWorkout();
            updateBanners();

            // Auto-scroll to the next available unchecked set
            setTimeout(() => {
                const nextSet = document.querySelector('#workout-container .check-circle:not(.checked)');
                if (nextSet) {
                    const y = nextSet.getBoundingClientRect().top + window.scrollY - 150;
                    window.scrollTo({ top: y, behavior: 'smooth' });
                } else {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            }, 150); 
        }

        function getWorkoutKey() {
            return `${currentProgram}_w${selectedWeek}_d${selectedDay}`;
        }

        function getActiveExercises(prog, w, d, key) {
            let base = db[prog]?.weeks[w]?.[d] || [];
            let exercises = JSON.parse(JSON.stringify(base)); // Deep copy
            
            let saved = safeParse(key, {});
            
            if (saved.addedExercises) exercises = exercises.concat(JSON.parse(JSON.stringify(saved.addedExercises)));
            
            if (saved.deletedIndices) {
                saved.deletedIndices.forEach(idx => {
                    if (exercises[idx]) exercises[idx].isDeleted = true;
                });
            }

            // NEW: Apply swapped names
            if (saved.swappedNames) {
                Object.keys(saved.swappedNames).forEach(idx => {
                    if (exercises[idx]) exercises[idx].name = saved.swappedNames[idx];
                });
            }

            // NEW: Apply Superset Links
            if (saved.supersets) {
                Object.keys(saved.supersets).forEach(idx => {
                    if (exercises[idx]) exercises[idx].supersetNext = saved.supersets[idx];
                });
            }

            // NEW: Apply modified notes
            if (saved.modifiedNotes) {
                Object.keys(saved.modifiedNotes).forEach(idx => {
                    if (exercises[idx]) exercises[idx].notes = saved.modifiedNotes[idx];
                });
            }

            // NEW: Apply modified set counts
            if (saved.modifiedBlocks) {
                Object.keys(saved.modifiedBlocks).forEach(bKey => {
                    const [eIdx, bIdx] = bKey.split('_');
                    if (exercises[eIdx] && exercises[eIdx].blocks[bIdx]) {
                        exercises[eIdx].blocks[bIdx].sets = saved.modifiedBlocks[bKey];
                    }
                });
            }
            
            return exercises;
        }

        async function toggleWorkoutState(action) {
            const key = getWorkoutKey();
            
            if (action === 'start') {
                if (activeWorkout && activeWorkout.key !== key) {
                    const confirmed = await showConfirm(
                        "Overwrite Active Session?",
                        "You already have a workout in progress. Do you want to discard it and start this one?",
                        "Start New",
                        "Cancel",
                        true
                    );
                    if (!confirmed) return;
                }
                
                // NEW: Make this the official active program ONLY if it is a real database program
                if (!currentProgram.startsWith('Custom_')) {
                    localStorage.setItem('activeProgram', currentProgram);
                }
                
                // SNAPSHOT ENGINE: Backup global stats so they can be reverted if the workout is canceled
                const backupState = {
                    actualBests: safeParse('actualBests', {}),
                    global1RMs: safeParse('global1RMs', {}),
                    lastUsedWeights: safeParse('lastUsedWeights', {})
                };
                
                activeWorkout = { key, program: currentProgram, week: selectedWeek, day: selectedDay, startTime: Date.now(), backupState: backupState };
                localStorage.setItem('activeWorkout', JSON.stringify(activeWorkout));
                delete completedDays[key];
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
            
            } else if (action === 'finish') {
                const keyForSummary = key; 
                const durationMs = activeWorkout && activeWorkout.startTime ? (Date.now() - activeWorkout.startTime) : 0;
                
                completedDays[key] = true;
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                activeWorkout = null;
                localStorage.removeItem('activeWorkout');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                closeTimer();
                clearInterval(workoutDurationInterval);
                const timerEl = document.getElementById('workout-duration');
                if (timerEl) timerEl.style.display = 'none';
                
                generateSummary(keyForSummary, durationMs); 
                updateDashboard();
                return; 
                
            } else if (action === 'restart') {
                delete completedDays[key];
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                
                const backupState = {
                    actualBests: safeParse('actualBests', {}),
                    global1RMs: safeParse('global1RMs', {}),
                    lastUsedWeights: safeParse('lastUsedWeights', {})
                };
                
                activeWorkout = { key, program: currentProgram, week: selectedWeek, day: selectedDay, startTime: Date.now(), backupState: backupState };
                localStorage.setItem('activeWorkout', JSON.stringify(activeWorkout));
            }
            
            renderDayPills();
            renderWorkout();
            updateBanners();
        }

        function generateSummary(key, durationMs = 0) {
            const savedSession = safeParse(key, {});
            const exercises = getActiveExercises(currentProgram, selectedWeek, selectedDay, key);
            
            let totalVolume = 0;
            let completedSets = 0;
            let maxLoad = 0;
            let exCount = exercises.length;
            
            let workoutDetails = [];

            exercises.forEach((ex, exIndex) => {
                if (ex.isDeleted) return; // NEW: Ignore deleted exercises in the summary log
                const exId = `ex-${exIndex}`;
                let exerciseLog = { name: ex.name, sets: [] };

                ex.blocks.forEach((block, bIndex) => {
                    for(let s = 1; s <= block.sets; s++) {
                        const rowId = `${exId}_b${bIndex}_s${s}`;
                        const checkId = `${rowId}_check`;
                        const loadInputId = `${rowId}_load`;
                        const rpeInputId = `${rowId}_rpe`;
                        const repsInputId = `${rowId}_reps`; 
                        
                        if (savedSession[checkId]) { 
                            completedSets++;
                            const load = parseFloat(savedSession[loadInputId]) || 0;
                            const rpe = savedSession[rpeInputId] || '';
                            const actualReps = parseFloat(savedSession[repsInputId]) || block.reps; 
                            
                            let effectiveLoad = load;
                            if (isBodyweightExercise(ex.name)) {
                                const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                                if (bw > 0) effectiveLoad += bw;
                            }
                            
                            totalVolume += (effectiveLoad * actualReps); 
                            if (effectiveLoad > maxLoad) maxLoad = effectiveLoad;
                            
                            exerciseLog.sets.push({ reps: actualReps, load: load, rpe: rpe });
                        }
                        
                        // Process extras tied directly to Set 's'
                        const extrasKey = `extras_${exIndex}_${bIndex}_s${s}`;
                        const extrasArray = savedSession[extrasKey] || [];
                        
                        extrasArray.forEach((extraData, eIdx) => {
                            const extraRowId = `${rowId}_extra_${eIdx}`;
                            const extraCheckId = `${extraRowId}_check`;
                            
                            if (savedSession[extraCheckId]) { 
                                completedSets++;
                                const load = parseFloat(savedSession[`${extraRowId}_load`]) || 0;
                                const rpe = savedSession[`${extraRowId}_rpe`] || '';
                                
                                let actualReps = parseFloat(savedSession[`${extraRowId}_reps`]);
                                if (isNaN(actualReps)) actualReps = extraData.reps;
                                
                                totalVolume += (load * actualReps);
                                if (load > maxLoad) maxLoad = load;
                                
                                exerciseLog.sets.push({ reps: actualReps, load: load, rpe: rpe, isTargetSet: true });
                            }
                        });
                    }
                });
                
                if (exerciseLog.sets.length > 0) workoutDetails.push(exerciseLog);
            });

            // --- SAFELY UPDATE UI ---
            let timeString = "00:00";
            if (durationMs > 0) {
                const totalSecs = Math.floor(durationMs / 1000);
                const h = Math.floor(totalSecs / 3600);
                const m = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, '0');
                const s = (totalSecs % 60).toString().padStart(2, '0');
                timeString = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
            }
            
            const timeEl = document.getElementById('sum-time');
            const volEl = document.getElementById('sum-vol');
            const setsEl = document.getElementById('sum-sets');
            const maxEl = document.getElementById('sum-max');
            const exEl = document.getElementById('sum-ex');

            if (timeEl) timeEl.innerText = timeString;
            if (volEl) volEl.innerText = `${totalVolume.toLocaleString()} kg`;
            if (setsEl) setsEl.innerText = completedSets;
            if (maxEl) maxEl.innerText = `${maxLoad} kg`;
            if (exEl) exEl.innerText = exCount;
            // ------------------------
            
            const logEntry = {
                id: Date.now().toString(),
                key: key,
                programName: db[currentProgram]?.name || currentProgram,
                week: selectedWeek,
                day: selectedDay,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                volume: totalVolume,
                sets: completedSets,
                duration: durationMs,
                details: workoutDetails 
            };
            
            workoutHistoryCache.unshift(logEntry); 
            setDB('workoutHistory', workoutHistoryCache);

            renderDayPills(); 
            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
            
            const summaryScreen = document.getElementById('summary-screen');
            if (summaryScreen) {
                summaryScreen.classList.add('active');
                if (typeof fireConfetti === 'function') fireConfetti();
            }
        }

    let currentChartEx = '';

        window.selectChartEx = function(ex) {
            currentChartEx = ex;
            document.getElementById('chart-exercise-btn').innerText = ex;
            document.getElementById('chart-exercise-modal').style.display = 'none';
            drawChart();
        };

        function initChartSelect() {
            let history = safeParse('workoutHistory', []);
            let exSet = new Set();
            history.forEach(log => log.details.forEach(e => exSet.add(e.name)));
            let listHtml = document.getElementById('chart-exercise-list');
            let selectDisplay = document.getElementById('chart-exercise-btn');
            if(!listHtml || !selectDisplay) return;
            
            let options = Array.from(exSet).sort();
            
            if(options.length === 0) {
                selectDisplay.innerText = 'No Data';
                listHtml.innerHTML = '<div style="padding: 15px; color: var(--text-muted); text-align: center;">No exercises logged yet.</div>';
                currentChartEx = '';
                drawChart();
                return;
            }
            
            if(!options.includes(currentChartEx)) {
                currentChartEx = options.includes('Squat') ? 'Squat' : options[0];
            }
            
            selectDisplay.innerText = currentChartEx;
            
            // Map the options into the new scrollable modal list
            listHtml.innerHTML = options.map(o => 
                `<div class="custom-option" style="padding: 15px 14px; border-bottom: 1px solid rgba(255,255,255,0.05);" onclick="selectChartEx('${o.replace(/'/g, "\\'")}')">${o}</div>`
            ).join('');
            
            drawChart();
        }

        window.drawChart = function() {
            const container = document.getElementById('chart-container');
            if(!container) return;
            if(!currentChartEx) {
                container.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:30px 0;color:var(--text-muted);">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    <span style="font-size:13px;font-style:italic;">Complete a workout to plot progress.</span>
                </div>`;
                return;
            }
            
            let exName = currentChartEx;
            let history = safeParse('workoutHistory', []).slice().reverse(); 
            
            // --- NEW: e1RM CALCULATION ENGINE FOR PLOTTING ---
            const getE1RM = (weight, reps, rpe) => {
                if (!weight || weight <= 0 || !reps || reps <= 0) return 0;
                
                const rtsChart = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };

                // Parse RPE, default to 10 (max effort) if the user didn't enter one
                let parsedRpe = parseFloat(rpe);
                if (isNaN(parsedRpe) || parsedRpe < 0 || parsedRpe > 10) parsedRpe = 10;
                
                let roundedRpe = Math.round(parsedRpe * 2) / 2;
                let repIndex = Math.max(0, Math.min(11, reps - 1));
                
                let percentage = 0;
                if (roundedRpe >= 5) {
                    percentage = rtsChart[roundedRpe][repIndex];
                } else {
                    percentage = Math.max(0.1, rtsChart[5][repIndex] - ((5 - roundedRpe) * 0.025));
                }
                
                return weight / percentage;
            };

            // Group by calendar day — keep only the highest e1RM per day
            let dayMap = {};
            history.forEach(log => {
                let exMatch = log.details.find(e => e.name === exName);
                if(exMatch && exMatch.sets && exMatch.sets.length > 0) {
                    let maxE1RM = Math.max(...exMatch.sets.map(s => getE1RM(s.load, s.reps, s.rpe)));
                    if(maxE1RM > 0) {
                        const ts = parseInt(log.id);
                        const dateKey = localDateKey(new Date(ts));
                        if(!dayMap[dateKey] || maxE1RM > dayMap[dateKey].value) {
                            dayMap[dateKey] = { value: parseFloat(maxE1RM.toFixed(1)), ts };
                        }
                    }
                }
            });
            let data = Object.values(dayMap).sort((a, b) => a.ts - b.ts).slice(-7);

            if(data.length < 2) {
                container.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:30px 0;color:var(--text-muted);">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                    <span style="font-size:13px;font-style:italic;">Need 2 sessions of this lift to plot progress.</span>
                </div>`;
                return;
            }
            
            let w = container.clientWidth; 
            let h = 140; 
            let padding = 20; 
            let minV = Math.min(...data.map(d => d.value));
            let maxV = Math.max(...data.map(d => d.value));
            let range = maxV - minV; 
            if(range === 0) range = 10; 
            
            // --- NEW: GENERATE BACKGROUND GRID ---
            let gridHtml = '';
            
            // 4 Horizontal lines for scale
            for (let i = 0; i < 4; i++) {
                let y = padding + (i * ((h - 2 * padding) / 3));
                gridHtml += `<line x1="10" y1="${y}" x2="${w - 10}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4" />`;
            }
            
            // Vertical lines marking each workout
            data.forEach((d, i) => {
                let x = (i / (data.length - 1)) * (w - 40) + 20;
                gridHtml += `<line x1="${x}" y1="${padding}" x2="${x}" y2="${h - padding}" stroke="rgba(255,255,255,0.05)" stroke-width="1" />`;
            });
            
            let points = data.map((d, i) => {
                let x = (i / (data.length - 1)) * (w - 40) + 20; 
                let y = h - padding - ((d.value - minV) / range) * (h - 2 * padding);
                return `${x},${y}`;
            }).join(' ');
            
            const fmtDate = ts => {
                const d = new Date(ts);
                return d.toLocaleDateString('default', { month: 'short', day: 'numeric' });
            };

            let circles = data.map((d, i) => {
                let x = (i / (data.length - 1)) * (w - 40) + 20;
                let y = h - padding - ((d.value - minV) / range) * (h - 2 * padding);
                return `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2"/>
                        <text x="${x}" y="${y - 12}" fill="var(--text-main)" font-size="11" font-weight="800" text-anchor="middle" font-family="Inter">${d.value}kg</text>
                        <text x="${x}" y="${h + 14}" fill="var(--text-muted)" font-size="9" text-anchor="middle" font-family="Inter">${fmtDate(d.ts)}</text>`;
            }).join('');
            
            // Build gradient fill polygon (line points + bottom corners)
            const ptArr = data.map((d, i) => {
                let x = (i / (data.length - 1)) * (w - 40) + 20;
                let y = h - padding - ((d.value - minV) / range) * (h - 2 * padding);
                return `${x},${y}`;
            });
            const fillPoly = [...ptArr, `${(w-40)+20},${h-padding}`, `20,${h-padding}`].join(' ');

            container.innerHTML = `<svg width="100%" height="${h}" style="overflow:visible;">
                                      <defs>
                                        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                                          <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.25"/>
                                          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
                                        </linearGradient>
                                      </defs>
                                      ${gridHtml}
                                      <polygon points="${fillPoly}" fill="url(#chartFill)" class="chart-fill"/>
                                      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>
                                      ${circles}
                                   </svg>`;
        };

    // Muscle involvement rules: pattern → { muscle: percentage }
    const MUSCLE_RULES = [
        { p: /squat|box squat|zercher|tempo squat|pause.*squat|safety bar|no belt.*squat|highbar|2.count pause.*squat|3.0.0 tempo.*squat|3.2.0.*squat|4.0.0.*squat|6.0.0.*squat/i, m: { quads: .45, glutes: .30, hamstrings: .15, core: .10 } },
        { p: /leg press|single leg press/i, m: { quads: .55, glutes: .30, hamstrings: .15 } },
        { p: /leg extension/i, m: { quads: .95, core: .05 } },
        { p: /lunge|bulgarian|split squat|reverse lunge/i, m: { quads: .40, glutes: .35, hamstrings: .20, core: .05 } },
        { p: /front squat/i, m: { quads: .55, glutes: .20, core: .15, hamstrings: .10 } },
        { p: /standard height|conventional.*dead|vs bands.*dead|pause.*dead|2ct pause.*dead|non comp.*dead|deficit dead|5.3.0.*dead/i, m: { back: .25, glutes: .25, hamstrings: .25, quads: .15, forearms: .10 } },
        { p: /romanian|rdl|stiff.?leg|single leg rdl|3.0.0 tempo.*dead|4.0.0.*stiff|6.0.0.*stiff|snatch.grip.*dead/i, m: { hamstrings: .40, glutes: .30, back: .20, forearms: .10 } },
        { p: /good morning/i, m: { hamstrings: .40, glutes: .30, lowerBack: .25, core: .05 } },
        { p: /leg curl|single.leg.*curl/i, m: { hamstrings: .85, calves: .15 } },
        { p: /back extension|low back/i, m: { lowerBack: .50, glutes: .30, hamstrings: .20 } },
        { p: /hip thrust|glute/i, m: { glutes: .65, hamstrings: .25, core: .10 } },
        { p: /bench|spoto|larsen|slingshot|board|touch and go|feet.?up|pin bench|overload.*bench|wide grip.*bench|pause.*bench|tempo bench|2ct pause bench|3.count.*bench|5ct pause.*bench|6.0.0 bench|4.0.0 tempo.*bench|3.0.0 tempo.*bench|machine chest press/i, m: { chest: .55, triceps: .25, frontDelts: .20 } },
        { p: /close grip bench|2ct pause close grip/i, m: { triceps: .45, chest: .35, frontDelts: .20 } },
        { p: /chest.?fly|cable.?chest/i, m: { chest: .85, frontDelts: .15 } },
        { p: /dip/i, m: { chest: .40, triceps: .40, frontDelts: .20 } },
        { p: /overhead press|ohp|shoulder press|seated.*press|strict press|military|clean and press|press away|seated bb ohp|seated pin press|seated strict/i, m: { frontDelts: .40, triceps: .30, chest: .15, core: .15 } },
        { p: /barbell row|pendlay|meadows|power row|seated.*row|chest supported|strict.*row|wide grip.*row|1.arm.*row/i, m: { back: .55, biceps: .25, rearDelts: .20 } },
        { p: /pull.?up|chin.?up|lat.?pull|rack chin|neutral grip|wide grip pull/i, m: { back: .50, biceps: .30, rearDelts: .10, forearms: .10 } },
        { p: /bicep|curl|preacher/i, m: { biceps: .85, forearms: .15 } },
        { p: /tricep|skull|pushdown|kickback|overhead.*extension/i, m: { triceps: .90, frontDelts: .10 } },
        { p: /rear delt/i, m: { rearDelts: .80, back: .20 } },
        { p: /face pull|pull apart|band pull/i, m: { rearDelts: .50, back: .30, biceps: .20 } },
        { p: /shrug/i, m: { traps: .85, forearms: .15 } },
        { p: /calf/i, m: { calves: 1.0 } },
        { p: /plank|crunch|ab|core|rolling plank|cable crunch/i, m: { core: 1.0 } },
        { p: /farmer|carry/i, m: { forearms: .30, traps: .25, core: .25, glutes: .20 } },
        { p: /snatch|one arm.*snatch/i, m: { back: .25, traps: .25, frontDelts: .20, glutes: .15, hamstrings: .15 } },
    ];

    function getMuscleSplit(name) {
        const n = (name || '').toLowerCase();
        for (const rule of MUSCLE_RULES) {
            if (rule.p.test(n)) return rule.m;
        }
        return null;
    }

    // Helper: local YYYY-MM-DD (avoids UTC shift from toISOString)
    function localDateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function renderHeatmap() {
        const card = document.getElementById('volume-heatmap-card');
        if (!card) return;

        const history = safeParse('workoutHistory', []);
        const WEEKS = 16;
        const DAYS = 7;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Align start to the most recent Monday
        const dayOfWeek = (today.getDay() + 6) % 7;
        const gridStart = new Date(today);
        gridStart.setDate(today.getDate() - dayOfWeek - (WEEKS - 1) * 7);

        // Build volume map and muscle breakdown map using LOCAL dates
        const volMap = {};
        const muscleMap = {};
        history.forEach(log => {
            const ts = parseInt(log.id);
            if (isNaN(ts)) return;
            const d = new Date(ts);
            d.setHours(0, 0, 0, 0);
            const key = localDateKey(d);
            volMap[key] = (volMap[key] || 0) + (log.volume || 0);
            if (!muscleMap[key]) muscleMap[key] = {};
            if (log.details && Array.isArray(log.details)) {
                log.details.forEach(ex => {
                    const split = getMuscleSplit(ex.name || '');
                    if (!split) return;
                    const exVol = (ex.sets || []).reduce((sum, s) => sum + ((s.load || 0) * (s.reps || 0)), 0);
                    Object.entries(split).forEach(([muscle, pct]) => {
                        muscleMap[key][muscle] = (muscleMap[key][muscle] || 0) + exVol * pct;
                    });
                });
            }
        });
        window.heatmapMuscleData = muscleMap;

        const maxVol = Math.max(...Object.values(volMap), 1);

        // Build cells using local dates
        const cells = [];
        for (let w = 0; w < WEEKS; w++) {
            const col = [];
            for (let d = 0; d < DAYS; d++) {
                const date = new Date(gridStart);
                date.setDate(gridStart.getDate() + w * 7 + d);
                const key = localDateKey(date);
                col.push({ key, vol: volMap[key] || 0, date });
            }
            cells.push(col);
        }

        // Month labels
        const monthLabels = cells.map((col, wi) => {
            const firstDay = col[0].date;
            const prevFirst = wi > 0 ? cells[wi - 1][0].date : null;
            if (!prevFirst || firstDay.getMonth() !== prevFirst.getMonth()) {
                return firstDay.toLocaleString('default', { month: 'short' });
            }
            return '';
        });

        const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

        const cellColor = (vol) => {
            if (vol <= 0) return '#27272a';
            const t = vol / maxVol;
            if (t < 0.25) return 'rgba(20,184,166,0.30)';
            if (t < 0.6)  return 'rgba(20,184,166,0.60)';
            return '#14b8a6';
        };

        // Colorbar labels
        const fmtVol = (v) => (v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(v)) + ' kg';

        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <span style="font-weight:800; font-size:14px; color:var(--text-main); display:flex; align-items:center; gap:8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--teal,#14b8a6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                Volume Heatmap
            </span>
            <span style="font-size:11px; color:var(--text-muted);">last ${WEEKS} weeks</span>
        </div>
        <div style="display:flex; gap:3px;">
            <div style="display:flex; flex-direction:column; gap:2px; margin-top:16px; margin-right:1px;">
                ${dayLabels.map((l, i) => i % 2 === 0
                    ? `<div style="width:10px; height:10px; font-size:7px; color:var(--text-muted); display:flex; align-items:center; justify-content:center;">${l}</div>`
                    : `<div style="width:10px; height:10px;"></div>`
                ).join('')}
            </div>
            <div style="display:flex; gap:2px; flex:1; overflow-x:auto; padding-bottom:2px;">
                ${cells.map((col, wi) => `
                <div style="display:flex; flex-direction:column; gap:2px; flex-shrink:0;">
                    <div style="height:14px; font-size:7px; color:var(--text-muted); white-space:nowrap; overflow:hidden;">${monthLabels[wi]}</div>
                    ${col.map(cell => `<div style="width:10px; height:10px; border-radius:2px; background:${cellColor(cell.vol)}; cursor:${cell.vol > 0 ? 'pointer' : 'default'};" onclick="showHeatmapTooltip(event,'${cell.key}')"></div>`).join('')}
                </div>`).join('')}
            </div>
            <div style="display:flex; flex-direction:column; align-items:center; margin-top:16px; margin-left:4px; gap:0;">
                <span style="font-size:7px; color:var(--text-muted); margin-bottom:2px;">${fmtVol(maxVol)}</span>
                <div style="width:8px; flex:1; border-radius:4px; background:linear-gradient(to bottom, #14b8a6, rgba(20,184,166,0.60), rgba(20,184,166,0.30), #27272a); min-height:60px;"></div>
                <span style="font-size:7px; color:var(--text-muted); margin-top:2px;">0</span>
            </div>
        </div>`;

        card.innerHTML = html;
    }

    // SVG anatomy: muscle color based on volume
    function mc(vol, maxV) {
        if (!vol || vol <= 0) return '#2a2a30';
        const t = Math.min(vol / maxV, 1);
        return 'rgba(20,184,166,' + (0.25 + 0.75 * t).toFixed(2) + ')';
    }

    // Anatomically accurate muscle polygons (react-body-highlighter, coordinate space 0-100 x, 0-220 y)
    const ANT = {
        head:       ['42.4489796 2.85714286 40 11.8367347 42.0408163 19.5918367 46.122449 23.2653061 49.7959184 25.3061224 54.6938776 22.4489796 57.5510204 19.1836735 59.1836735 10.2040816 57.1428571 2.44897959 49.7959184 0'],
        neck:       ['55.5102041 23.6734694 50.6122449 33.4693878 50.6122449 39.1836735 61.6326531 40 70.6122449 44.8979592 69.3877551 36.7346939 63.2653061 35.1020408 58.3673469 30.6122449','28.9795918 44.8979592 30.2040816 37.1428571 36.3265306 35.1020408 41.2244898 30.2040816 44.4897959 24.4897959 48.9795918 33.877551 48.5714286 39.1836735 37.9591837 39.5918367'],
        chest:      ['51.8367347 41.6326531 51.0204082 55.1020408 57.9591837 57.9591837 67.755102 55.5102041 70.6122449 47.3469388 62.0408163 41.6326531','29.7959184 46.5306122 31.4285714 55.5102041 40.8163265 57.9591837 48.1632653 55.1020408 47.755102 42.0408163 37.5510204 42.0408163'],
        obliques:   ['68.5714286 63.2653061 67.3469388 57.1428571 58.7755102 59.5918367 60 64.0816327 60.4081633 83.2653061 65.7142857 78.7755102 66.5306122 69.7959184','33.877551 78.3673469 33.0612245 71.8367347 31.0204082 63.2653061 32.244898 57.1428571 40.8163265 59.1836735 39.1836735 63.2653061 39.1836735 83.6734694'],
        abs:        ['56.3265306 59.1836735 57.9591837 64.0816327 58.3673469 77.9591837 58.3673469 92.6530612 56.3265306 98.3673469 55.1020408 104.081633 51.4285714 107.755102 51.0204082 84.4897959 50.6122449 67.3469388 51.0204082 57.1428571','43.6734694 58.7755102 48.5714286 57.1428571 48.9795918 67.3469388 48.5714286 84.4897959 48.1632653 107.346939 44.4897959 103.673469 40.8163265 91.4285714 40.8163265 78.3673469 41.2244898 64.4897959'],
        biceps:     ['16.7346939 68.1632653 17.9591837 71.4285714 22.8571429 66.122449 28.9795918 53.877551 27.755102 49.3877551 20.4081633 55.9183673','71.4285714 49.3877551 70.2040816 54.6938776 76.3265306 66.122449 81.6326531 71.8367347 82.8571429 68.9795918 78.7755102 55.5102041'],
        triceps:    ['69.3877551 55.5102041 69.3877551 61.6326531 75.9183673 72.6530612 77.5510204 70.2040816 75.5102041 67.3469388','22.4489796 69.3877551 29.7959184 55.5102041 29.7959184 60.8163265 22.8571429 73.0612245'],
        frontDelts: ['78.3673469 53.0612245 79.5918367 47.755102 79.1836735 41.2244898 75.9183673 37.9591837 71.0204082 36.3265306 72.244898 42.8571429 71.4285714 47.3469388','28.1632653 47.3469388 21.2244898 53.0612245 20 47.755102 20.4081633 40.8163265 24.4897959 37.1428571 28.5714286 37.1428571 26.9387755 43.2653061'],
        abductors:  ['52.6530612 110.204082 54.2857143 124.897959 60 110.204082 62.0408163 100 64.8979592 94.2857143 60 92.6530612 56.7346939 104.489796','47.755102 110.612245 44.8979592 125.306122 42.0408163 115.918367 40.4081633 113.061224 39.5918367 107.346939 37.9591837 102.44898 34.6938776 93.877551 39.5918367 92.244898 41.6326531 99.1836735 43.6734694 105.306122'],
        quads:      ['34.6938776 98.7755102 37.1428571 108.163265 37.1428571 127.755102 34.2857143 137.142857 31.0204082 132.653061 29.3877551 120 28.1632653 111.428571 29.3877551 100.816327 32.244898 94.6938776','63.2653061 105.714286 64.4897959 100 66.9387755 94.6938776 70.2040816 101.22449 71.0204082 111.836735 68.1632653 133.061224 65.3061224 137.55102 62.4489796 128.571429 62.0408163 111.428571','38.7755102 129.387755 38.3673469 112.244898 41.2244898 118.367347 44.4897959 129.387755 42.8571429 135.102041 40 146.122449 36.3265306 146.530612 35.5102041 140','59.5918367 145.714286 55.5102041 128.979592 60.8163265 113.877551 61.2244898 130.204082 64.0816327 139.591837 62.8571429 146.530612','32.6530612 138.367347 26.5306122 145.714286 25.7142857 136.734694 25.7142857 127.346939 26.9387755 114.285714 29.3877551 133.469388','71.8367347 113.061224 73.877551 124.081633 73.877551 140.408163 72.6530612 145.714286 66.5306122 138.367347 70.2040816 133.469388'],
        knees:      ['33.877551 140 34.6938776 143.265306 35.5102041 147.346939 36.3265306 151.020408 35.1020408 156.734694 29.7959184 156.734694 27.3469388 152.653061 27.3469388 147.346939 30.2040816 144.081633','65.7142857 140 72.244898 147.755102 72.244898 152.244898 69.7959184 157.142857 64.8979592 156.734694 62.8571429 151.020408'],
        calves:     ['71.4285714 160.408163 73.4693878 153.469388 76.7346939 161.22449 79.5918367 167.755102 78.3673469 187.755102 79.5918367 195.510204 74.6938776 195.510204','24.8979592 194.693878 27.755102 164.897959 28.1632653 160.408163 26.122449 154.285714 24.8979592 157.55102 22.4489796 161.632653 20.8163265 167.755102 22.0408163 188.163265 20.8163265 195.510204','72.6530612 195.102041 69.7959184 159.183673 65.3061224 158.367347 64.0816327 162.44898 64.0816327 165.306122 65.7142857 177.142857','35.5102041 158.367347 35.9183673 162.44898 35.9183673 166.938776 35.1020408 172.244898 35.1020408 176.734694 32.244898 182.040816 30.6122449 187.346939 26.9387755 194.693878 27.3469388 187.755102 28.1632653 180.408163 28.5714286 175.510204 28.9795918 169.795918 29.7959184 164.081633 30.2040816 158.77551'],
        forearms:   ['6.12244898 88.5714286 10.2040816 75.1020408 14.6938776 70.2040816 16.3265306 74.2857143 19.1836735 73.4693878 4.48979592 97.5510204 0 100','84.4897959 69.7959184 83.2653061 73.4693878 80 73.0612245 95.1020408 98.3673469 100 100.408163 93.4693878 89.3877551 89.7959184 76.3265306','77.5510204 72.244898 77.5510204 77.5510204 80.4081633 84.0816327 85.3061224 89.7959184 92.244898 101.22449 94.6938776 99.5918367','6.93877551 101.22449 13.4693878 90.6122449 18.7755102 84.0816327 21.6326531 77.1428571 21.2244898 71.8367347 4.89795918 98.7755102']
    };

    const POST = {
        head:       ['50.6382979 0 45.9574468 0.85106383 40.8510638 5.53191489 40.4255319 12.7659574 45.106383 20 55.7446809 20 59.1489362 13.6170213 59.5744681 4.68085106 55.7446809 1.27659574'],
        traps:      ['44.6808511 21.7021277 47.6595745 21.7021277 47.2340426 38.2978723 47.6595745 64.6808511 38.2978723 53.1914894 35.3191489 40.8510638 31.0638298 36.5957447 39.1489362 33.1914894 43.8297872 27.2340426','52.3404255 21.7021277 55.7446809 21.7021277 56.5957447 27.2340426 60.8510638 32.7659574 68.9361702 36.5957447 64.6808511 40.4255319 61.7021277 53.1914894 52.3404255 64.6808511 53.1914894 38.2978723'],
        rearDelts:  ['29.3617021 37.0212766 22.9787234 39.1489362 17.4468085 44.2553191 18.2978723 53.6170213 24.2553191 49.3617021 27.2340426 46.3829787','71.0638298 37.0212766 78.2978723 39.5744681 82.5531915 44.6808511 81.7021277 53.6170213 74.893617 48.9361702 72.3404255 45.106383'],
        back:       ['31.0638298 38.7234043 28.0851064 48.9361702 28.5106383 55.3191489 34.0425532 75.3191489 47.2340426 71.0638298 47.2340426 66.3829787 36.5957447 54.0425532 33.6170213 41.2765957','68.9361702 38.7234043 71.9148936 49.3617021 71.4893617 56.1702128 65.9574468 75.3191489 52.7659574 71.0638298 52.7659574 66.3829787 63.4042553 54.4680851 66.3829787 41.7021277'],
        triceps:    ['26.8085106 49.787234 17.8723404 55.7446809 14.4680851 72.3404255 16.5957447 81.7021277 21.7021277 63.8297872 26.8085106 55.7446809','73.6170213 50.212766 82.1276596 55.7446809 85.9574468 73.1914894 83.4042553 82.1276596 77.8723404 62.9787234 73.1914894 55.7446809','26.8085106 58.2978723 26.8085106 68.5106383 22.9787234 75.3191489 19.1489362 77.4468085 22.5531915 65.5319149','72.7659574 58.2978723 77.0212766 64.6808511 80.4255319 77.4468085 76.5957447 75.3191489 72.7659574 68.9361702'],
        lowerBack:  ['47.6595745 72.7659574 34.4680851 77.0212766 35.3191489 83.4042553 49.3617021 102.12766 46.8085106 82.9787234','52.3404255 72.7659574 65.5319149 77.0212766 64.6808511 83.4042553 50.6382979 102.12766 53.1914894 83.8297872'],
        forearms:   ['86.3829787 75.7446809 91.0638298 83.4042553 93.1914894 94.0425532 100 106.382979 96.1702128 104.255319 88.0851064 89.3617021 84.2553191 83.8297872','13.6170213 75.7446809 8.93617021 83.8297872 6.80851064 93.6170213 0 106.382979 3.82978723 104.255319 12.3404255 88.5106383 15.7446809 82.9787234','81.2765957 79.5744681 77.4468085 77.8723404 79.1489362 84.6808511 91.0638298 103.829787 93.1914894 108.93617 94.4680851 104.680851','18.7234043 79.5744681 22.1276596 77.8723404 20.8510638 84.2553191 9.36170213 102.978723 6.80851064 108.510638 5.10638298 104.680851'],
        glutes:     ['44.6808511 99.5744681 30.212766 108.510638 29.787234 118.723404 31.4893617 125.957447 47.2340426 121.276596 49.3617021 114.893617','55.3191489 99.1489362 51.0638298 114.468085 52.3404255 120.851064 68.0851064 125.957447 69.787234 119.148936 69.3617021 108.510638'],
        abductor:   ['48.0851064 122.978723 44.6808511 122.978723 41.2765957 125.531915 45.106383 144.255319 48.5106383 135.744681 48.9361702 129.361702','51.9148936 122.553191 55.7446809 123.404255 59.1489362 125.957447 54.893617 144.255319 51.9148936 136.170213 51.0638298 129.361702'],
        hamstrings: ['28.9361702 122.12766 31.0638298 129.361702 36.5957447 125.957447 35.3191489 135.319149 34.4680851 150.212766 29.3617021 158.297872 28.9361702 146.808511 27.6595745 141.276596 27.2340426 131.489362','71.4893617 121.702128 69.3617021 128.93617 63.8297872 125.957447 65.5319149 136.595745 66.3829787 150.212766 71.0638298 158.297872 71.4893617 147.659574 72.7659574 142.12766 73.6170213 131.914894','38.7234043 125.531915 44.2553191 145.957447 40.4255319 166.808511 36.1702128 152.765957 37.0212766 135.319149','61.7021277 125.531915 63.4042553 136.170213 64.2553191 153.191489 60 166.808511 56.1702128 146.382979'],
        knees:      ['34.4680851 153.191489 31.0638298 159.148936 33.6170213 166.382979 37.4468085 162.553191','66.3829787 153.617021 62.9787234 162.978723 66.8085106 166.382979 69.3617021 159.148936'],
        calves:     ['29.3617021 160.425532 28.5106383 167.234043 24.6808511 179.574468 23.8297872 192.765957 25.5319149 197.021277 28.5106383 193.191489 29.787234 180 31.9148936 171.06383 31.9148936 166.808511','37.4468085 165.106383 35.3191489 167.659574 33.1914894 171.914894 31.0638298 180.425532 30.212766 191.914894 34.0425532 200 38.7234043 190.638298 39.1489362 168.93617','62.9787234 165.106383 61.2765957 168.510638 61.7021277 190.638298 66.3829787 199.574468 70.6382979 191.914894 68.9361702 179.574468 66.8085106 170.212766','70.6382979 160.425532 72.3404255 168.510638 75.7446809 179.148936 76.5957447 192.765957 74.4680851 196.595745 72.3404255 193.617021 70.6382979 179.574468 68.0851064 168.085106'],
        soleus:     ['28.5106383 195.744681 30.212766 195.744681 33.6170213 201.702128 30.6382979 220 28.5106383 213.617021 26.8085106 198.297872','69.787234 195.744681 71.9148936 195.744681 73.6170213 198.297872 71.9148936 213.191489 70.212766 219.574468 67.2340426 202.12766']
    };

    // Map our tracking keys to the correct polygon arrays
    const ANT_TRACK = {
        chest:      ANT.chest,
        core:       ANT.abs.concat(ANT.obliques),
        biceps:     ANT.biceps,
        triceps:    ANT.triceps,
        frontDelts: ANT.frontDelts,
        quads:      ANT.quads,
        calves:     ANT.calves,
        forearms:   ANT.forearms
    };
    const POST_TRACK = {
        traps:      POST.traps,
        rearDelts:  POST.rearDelts,
        back:       POST.back,
        triceps:    POST.triceps,
        lowerBack:  POST.lowerBack,
        glutes:     POST.glutes,
        hamstrings: POST.hamstrings,
        calves:     POST.calves.concat(POST.soleus),
        forearms:   POST.forearms
    };

    function polyStr(pts, fill) {
        return pts.map(function(p) { return '<polygon points="' + p + '" fill="' + fill + '" stroke="none"/>'; }).join('');
    }

    function bodyFrontSVG(d, mx) {
        var BASE = '#2d2d36';
        var svg = '<svg viewBox="0 0 100 220" width="90" height="198" xmlns="http://www.w3.org/2000/svg" style="background:#17171b;border-radius:6px;">';
        Object.values(ANT).forEach(function(pts) { svg += polyStr(pts, BASE); });
        Object.keys(ANT_TRACK).forEach(function(muscle) {
            if (d[muscle] > 0) svg += polyStr(ANT_TRACK[muscle], mc(d[muscle], mx));
        });
        svg += '<text x="50" y="213" fill="#52525b" font-size="7" text-anchor="middle" font-family="Inter,sans-serif">FRONT</text>';
        svg += '</svg>';
        return svg;
    }

    function bodyBackSVG(d, mx) {
        var BASE = '#2d2d36';
        var svg = '<svg viewBox="0 0 100 220" width="90" height="198" xmlns="http://www.w3.org/2000/svg" style="background:#17171b;border-radius:6px;">';
        Object.values(POST).forEach(function(pts) { svg += polyStr(pts, BASE); });
        Object.keys(POST_TRACK).forEach(function(muscle) {
            if (d[muscle] > 0) svg += polyStr(POST_TRACK[muscle], mc(d[muscle], mx));
        });
        svg += '<text x="50" y="213" fill="#52525b" font-size="7" text-anchor="middle" font-family="Inter,sans-serif">BACK</text>';
        svg += '</svg>';
        return svg;
    }

    // Pretty muscle names for legend
    const MUSCLE_LABELS = {
        chest:'Chest', quads:'Quads', hamstrings:'Hamstrings', back:'Back', glutes:'Glutes',
        frontDelts:'Front Delts', rearDelts:'Rear Delts', triceps:'Triceps', biceps:'Biceps',
        core:'Core', forearms:'Forearms', calves:'Calves', traps:'Traps', lowerBack:'Lower Back'
    };

    window.showHeatmapTooltip = function(e, dateKey) {
        const data = (window.heatmapMuscleData || {})[dateKey];
        if (!data || Object.keys(data).length === 0) return;
        e.stopPropagation();

        const existing = document.getElementById('heatmap-tooltip');
        if (existing) existing.remove();

        const maxV = Math.max(...Object.values(data));
        const entries = Object.entries(data).filter(([,v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const totalVol = entries.reduce((s, [,v]) => s + v, 0);

        const [y, m, day] = dateKey.split('-');
        const label = new Date(+y, +m - 1, +day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        // Legend: top muscles with colored dots
        const legend = entries.slice(0, 6).map(([muscle, vol]) => {
            const pct = Math.round(vol / totalVol * 100);
            const color = mc(vol, maxV);
            return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                <div style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;"></div>
                <span style="color:#a1a1aa;font-size:9px;flex:1;">${MUSCLE_LABELS[muscle] || muscle}</span>
                <span style="color:#fff;font-size:9px;font-weight:700;">${pct}%</span>
            </div>`;
        }).join('');

        const tip = document.createElement('div');
        tip.id = 'heatmap-tooltip';
        tip.innerHTML = `
            <div style="font-size:11px;font-weight:800;color:var(--teal,#14b8a6);margin-bottom:8px;letter-spacing:0.5px;text-align:center;">${label}</div>
            <div style="display:flex;gap:4px;justify-content:center;margin-bottom:8px;">
                ${bodyFrontSVG(data, maxV)}
                ${bodyBackSVG(data, maxV)}
            </div>
            <div style="border-top:1px solid #2a2a2e;padding-top:6px;">
                ${legend}
            </div>
            <div style="text-align:center;margin-top:4px;font-size:8px;color:#52525b;">${Math.round(totalVol).toLocaleString()} kg total</div>`;
        tip.style.cssText = `position:fixed;background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:12px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.6);pointer-events:none;`;

        document.body.appendChild(tip);

        const rect = e.target.getBoundingClientRect();
        const tipW = tip.offsetWidth;
        const tipH = tip.offsetHeight;
        let left = rect.left + rect.width / 2 - tipW / 2;
        let top = rect.top - tipH - 8;
        if (left < 8) left = 8;
        if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
        if (top < 8) top = rect.bottom + 8;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';

        setTimeout(() => document.addEventListener('click', () => {
            const t = document.getElementById('heatmap-tooltip');
            if (t) t.remove();
        }, { once: true }), 0);
    };

    function renderHistory() {
            renderHeatmap();
            const historyContainer = document.getElementById('history-container');
            let history = safeParse('workoutHistory', []);

            if (history.length === 0) {
                historyContainer.innerHTML = '<div class="empty-history">No workouts logged yet. Your history will appear here.</div>';
                return;
            }

            // Slice the array based on the current limit (defaults to 3)
            const limit = window.historyDisplayLimit || 3;
            const visibleHistory = history.slice(0, limit);

            let html = visibleHistory.map(log => {
                let detailsHtml = '';
                if (log.details && log.details.length > 0) {
                    detailsHtml = `<div class="history-details">`;
                    log.details.forEach(ex => {
                        detailsHtml += `<div class="hd-ex-name">${ex.name}</div>`;
                        ex.sets.forEach((set, i) => {
                            let rpeText = set.rpe ? `RPE ${set.rpe}` : '';
                            detailsHtml += `
                            <div class="hd-set-row">
                                <span>Set ${i+1}</span>
                                <span>${kgDisp(set.load)} ${unitSuffix()} × ${set.reps}</span>
                                <span>${rpeText}</span>
                            </div>`;
                        });
                    });
                    detailsHtml += `</div>`;
                } else {
                    detailsHtml = `<div class="history-details"><div class="hd-set-row"><span>No detailed set data available for this legacy log.</span></div></div>`;
                }

                const dur = fmtDuration(log.duration);
                const volDisplay = `${kgDisp(log.volume, 0).toLocaleString()} ${unitSuffix()}`;
                const safeId  = (log.id  || '').replace(/'/g, "\\'");
                const safeKey = (log.key || '').replace(/'/g, "\\'");
                return `
                <div class="swipe-wrapper hist-swipe">
                    <div class="swipe-delete-bg" style="right:15px;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </div>
                    <details class="history-card hist-swipable" data-id="${safeId}" data-key="${safeKey}">
                        <summary class="history-summary">
                            <span class="history-date">${log.date}${dur ? `<span class="duration-badge">${dur}</span>` : ''}</span>
                            <h3 class="history-title">${log.programName} (W${log.week} D${log.day})</h3>
                            <div class="history-stats">${log.sets} Sets • ${volDisplay} Volume</div>
                            <div class="history-expand-indicator">▼ Expand</div>
                        </summary>
                        ${detailsHtml}
                    </details>
                </div>
                `;
            }).join('');

            // Render Clean Pagination Buttons
            let buttonsHtml = '<div style="display: flex; justify-content: center; gap: 15px; margin-top: 10px; margin-bottom: 25px;">';
            let showButtons = false;

            // Show "Show Less" if expanded
            if (limit > 3) {
                buttonsHtml += `<button class="reset-btn" style="padding: 10px 18px; font-size: 13px; border: none; background: rgba(255,255,255,0.05); color: var(--text-muted);" onclick="collapseHistory()">▲ Show Less</button>`;
                showButtons = true;
            }

            // Show "See More" if there's more history
            if (history.length > limit) {
                buttonsHtml += `<button class="reset-btn" style="padding: 10px 18px; font-size: 13px; border: none; background: rgba(255,255,255,0.08); color: var(--text-main);" onclick="loadMoreHistory()">▼ See More</button>`;
                showButtons = true;
            }

            buttonsHtml += '</div>';

            if (showButtons) html += buttonsHtml;

            historyContainer.innerHTML = html;
            setupHistorySwipe();
        }

        function setupHistorySwipe() {
            document.querySelectorAll('.hist-swipable').forEach(el => {
                let startX = 0, startY = 0, currentX = 0, isDragging = false, isScrolling = false;

                const startDrag = (e) => {
                    if (e.target.closest('button')) return;
                    startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
                    startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                    isDragging = true; isScrolling = false;
                    el.classList.add('swiping');
                };

                const moveDrag = (e) => {
                    if (!isDragging) return;
                    const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
                    const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                    const diffX = clientX - startX;
                    const diffY = Math.abs(clientY - startY);
                    if (!isScrolling && diffY > 10 && diffY > Math.abs(diffX)) isScrolling = true;
                    if (isScrolling) return;
                    currentX = diffX;
                    if (currentX < 0) {
                        if (e.cancelable) e.preventDefault();
                        el.style.transform = `translateX(${currentX}px)`;
                    }
                };

                const endDrag = () => {
                    if (!isDragging) return;
                    isDragging = false;
                    el.classList.remove('swiping');
                    const moved = Math.abs(currentX) > 5;
                    if (!isScrolling && currentX < -80) {
                        el.style.transform = `translateX(-100%)`;
                        setTimeout(() => deleteHistoryLog(el.dataset.id, el.dataset.key), 200);
                    } else {
                        el.style.transform = `translateX(0px)`;
                    }
                    if (moved && !isScrolling) {
                        el.dataset.swipeMoved = '1';
                        setTimeout(() => delete el.dataset.swipeMoved, 100);
                    }
                    currentX = 0;
                };

                el.addEventListener('touchstart', startDrag, {passive: true});
                el.addEventListener('touchmove', moveDrag, {passive: false});
                el.addEventListener('touchend', endDrag);
                el.addEventListener('mousedown', startDrag);
                el.addEventListener('mousemove', moveDrag);
                el.addEventListener('mouseup', endDrag);
                el.addEventListener('mouseleave', endDrag);
                el.addEventListener('click', (e) => { if (el.dataset.swipeMoved) e.preventDefault(); });
            });
        }

        window.loadMoreHistory = function() {
            window.historyDisplayLimit = (window.historyDisplayLimit || 3) + 5; 
            renderHistory();
        };

        window.collapseHistory = function() {
            window.historyDisplayLimit = 3; 
            renderHistory();
            window.scrollTo({ top: 0, behavior: 'smooth' }); // Smoothly snaps back to the top!
        };

        async function deleteHistoryLog(id, key) {
            const confirmed = await showConfirm(
                "Delete Log?",
                "This will permanently remove this session from your history.",
                "Delete",
                "Cancel",
                true
            );
            
            if (confirmed) {
                // Update Cache and DB
                workoutHistoryCache = workoutHistoryCache.filter(h => h.id !== id);
                setDB('workoutHistory', workoutHistoryCache);

                delete completedDays[key];
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                localStorage.removeItem(key);

                if (activeWorkout && activeWorkout.key === key) {
                    activeWorkout = null;
                    localStorage.removeItem('activeWorkout');
                }

                renderHistory();
                updateDashboard();
                renderDayPills();
            } else {
                renderHistory(); // Snap swiped card back
            }
        }

        // --- PROGRAM MANAGEMENT FUNCTIONS ---
        async function stopProgram() {
            const confirmed = await showConfirm(
                "Stop Program?",
                "This will exit the program and remove it from your Active status. Your history is safe.",
                "Stop & Exit",
                "Cancel",
                true
            );
            if(confirmed) {
                currentProgram = null;
                localStorage.removeItem('activeProgram');
                activeWorkout = null;
                localStorage.removeItem('activeWorkout');
                updateLibraryUI();
                switchTab('home-screen');
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        async function clearCurrentDay() {
            const confirmed = await showConfirm(
                "Reset Day?",
                "This will clear all weights, RPEs, and checkmarks for this specific workout.",
                "Reset Day",
                "Cancel",
                true
            );
            if (confirmed) {
                const key = getWorkoutKey();
                
                // REVERT ENGINE: Restore the snapshot if resetting the currently active day
                if (activeWorkout && activeWorkout.key === key && activeWorkout.backupState) {
                    localStorage.setItem('actualBests', JSON.stringify(activeWorkout.backupState.actualBests));
                    localStorage.setItem('global1RMs', JSON.stringify(activeWorkout.backupState.global1RMs));
                    localStorage.setItem('lastUsedWeights', JSON.stringify(activeWorkout.backupState.lastUsedWeights));
                }

                localStorage.removeItem(key);
                delete completedDays[key];
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                if (activeWorkout && activeWorkout.key === key) {
                    activeWorkout = null;
                    localStorage.removeItem('activeWorkout');
                }
                renderDayPills();
                renderWorkout(); 
                updateBanners();
                closeTimer();
                updateDashboard();
            }
        }

        async function clearCurrentWeek() {
            const confirmed = await showConfirm(
                "Reset Week?",
                "This will clear all weights and checkmarks for ALL days in Week " + selectedWeek + ".",
                "Reset Week",
                "Cancel",
                true
            );
            if(confirmed) {
                const days = Object.keys(db[currentProgram]?.weeks[selectedWeek] || {});
                days.forEach(d => {
                    const key = `${currentProgram}_w${selectedWeek}_d${d}`;
                    localStorage.removeItem(key);
                    delete completedDays[key];
                });
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                if(activeWorkout && activeWorkout.program === currentProgram && activeWorkout.week === selectedWeek) {
                    activeWorkout = null;
                    localStorage.removeItem('activeWorkout');
                }
                renderDayPills();
                renderWorkout();
                updateDashboard();
            }
        }

        async function clearCurrentProgram() {
            const confirmed = await showConfirm(
                "Reset Entire Program?",
                "This will wipe all progress for this entire program block. You will start fresh from Week 1.",
                "Reset Program",
                "Cancel",
                true
            );
            if(confirmed) {
                const weeks = Object.keys(db[currentProgram]?.weeks || {});
                weeks.forEach(w => {
                    const days = Object.keys(db[currentProgram]?.weeks[w] || {});
                    days.forEach(d => {
                        const key = `${currentProgram}_w${w}_d${d}`;
                        localStorage.removeItem(key);
                        delete completedDays[key];
                    });
                });
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                if(activeWorkout && activeWorkout.program === currentProgram) {
                    activeWorkout = null;
                    localStorage.removeItem('activeWorkout');
                }
                renderWeekPills();
                renderDayPills();
                renderWorkout();
                updateDashboard();
            }
        }

        async function clearAllPRs() {
            const confirmed = await showConfirm(
                "Factory Reset?",
                "This will wipe absolutely everything: history, PRs, active programs, and all data. This cannot be undone.",
                "Wipe Everything",
                "Cancel",
                true
            );
            if (confirmed) {
                localStorage.clear();
                workoutHistoryCache = [];
                await setDB('workoutHistory', []); // Clear DB
                
                completedDays = {};
                activeWorkout = null;
                currentProgram = null;
                selectedWeek = null;
                selectedDay = null;
                renderStats();
                checkOnboarding();
                updateDashboard();
                updateLibraryUI();
                
                renderHistory();
                if (typeof drawChart === 'function') drawChart();
            }
        }

        window.updateManual1RM = function(exName, val) {
            let global1RMs = safeParse('global1RMs', {});
            let num = parseFloat(val);
            if (num > 0) {
                global1RMs[exName] = num;
            } else {
                global1RMs[exName] = 0; 
            }
            localStorage.setItem('global1RMs', JSON.stringify(global1RMs));
        };
        
        window.resetSpecificLift = async function(exName) {
            const confirmed = await showConfirm(
                "Reset Lift?",
                `This will permanently erase your 1RM and All-Time Best records for ${exName}.`,
                "Reset Lift",
                "Cancel",
                true
            );
            if (confirmed) {
                let r = safeParse('global1RMs', {}); delete r[exName]; localStorage.setItem('global1RMs', JSON.stringify(r));
                let b = safeParse('actualBests', {}); delete b[exName]; localStorage.setItem('actualBests', JSON.stringify(b));
                let w = safeParse('lastUsedWeights', {}); delete w[exName]; localStorage.setItem('lastUsedWeights', JSON.stringify(w));
                renderStats();
            } else {
                renderStats(); // Snaps the swiped card back to normal if cancelled
            }
        };
        window.deleteTopPR = async function(exName) {
            const actualBests = safeParse('actualBests', {});
            const best = actualBests[exName];
            if (!best) { renderStats(); return; }
            const prHist = safeParse('prHistory', {});
            const remaining = (prHist[exName] || []).filter(e => e.date !== best.date);
            const msg = remaining.length > 0
                ? `Remove the current best for ${exName}? The next-best PR will become your new record.`
                : `Remove the only PR record for ${exName}?`;
            const confirmed = await showConfirm(
                "Delete Top PR?",
                msg,
                "Delete",
                "Cancel",
                true
            );
            if (confirmed) {
                // Handle deletion directly to guarantee renderStats is always called
                prHist[exName] = remaining;
                localStorage.setItem('prHistory', JSON.stringify(prHist));
                if (remaining.length === 0) {
                    delete actualBests[exName];
                } else {
                    const newBest = remaining.reduce((a, b) => b.e1rm > a.e1rm ? b : a, remaining[0]);
                    actualBests[exName] = { weight: newBest.weight, reps: newBest.reps, e1rm: newBest.e1rm, date: newBest.date };
                }
                localStorage.setItem('actualBests', JSON.stringify(actualBests));
            }
            renderStats(); // Always re-render (both confirm and cancel)
        };
        function setupStatsSwipe() {
            const bindSwipe = (el, threshold, onTrigger) => {
                let startX = 0, startY = 0, currentX = 0, isDragging = false, isScrolling = false;
                
                const startDrag = (e) => {
                    if (e.target.tagName.toLowerCase() === 'input' || e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
                    startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
                    startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                    isDragging = true; isScrolling = false;
                    el.classList.add('swiping');
                };
                
                const moveDrag = (e) => {
                    if (!isDragging) return;
                    let clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
                    let clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                    let diffX = clientX - startX;
                    let diffY = Math.abs(clientY - startY);
                    
                    if (!isScrolling && diffY > 10 && diffY > Math.abs(diffX)) isScrolling = true;
                    if (isScrolling) return;
                    
                    currentX = diffX;
                    if (currentX < 0) {
                        if (e.cancelable) e.preventDefault();
                        el.style.transform = `translateX(${currentX}px)`;
                    }
                };
                
                const endDrag = (e) => {
                    if (!isDragging) return;
                    isDragging = false;
                    el.classList.remove('swiping');
                    if (!isScrolling && currentX < threshold) {
                        el.style.transform = `translateX(-100%)`;
                        setTimeout(onTrigger, 200);
                    } else {
                        el.style.transform = `translateX(0px)`;
                    }
                    currentX = 0;
                };
                
                el.addEventListener('touchstart', startDrag, {passive: true});
                el.addEventListener('touchmove', moveDrag, {passive: false});
                el.addEventListener('touchend', endDrag);
                el.addEventListener('mousedown', startDrag);
                el.addEventListener('mousemove', moveDrag);
                el.addEventListener('mouseup', endDrag);
                el.addEventListener('mouseleave', endDrag);
            };

            document.querySelectorAll('.stat-swipable').forEach(el => {
                bindSwipe(el, -80, () => deleteTopPR(el.dataset.exname));
            });
        }
        // --- NEW: PHYSIQUE TRACKING ENGINE ---
        window.handlePictureUpload = function(event) {
            const file = event.target.files[0];
            if (!file) return;

            // Show loading state
            const gallery = document.getElementById('physique-gallery');
            if (gallery) gallery.innerHTML = '<div style="color: var(--accent); font-weight: 700; font-size: 13px;">Compressing and saving...</div>';

            const reader = new FileReader();
            reader.onload = function(e) {
                const img = new Image();
                img.onload = async function() {
                    const canvas = document.createElement('canvas');
                    const MAX_WIDTH = 600; // Optimal size for mobile grids without crushing DB
                    const MAX_HEIGHT = 800;
                    let width = img.width;
                    let height = img.height;

                    // Calculate aspect ratio
                    if (width > height) {
                        if (width > MAX_WIDTH) {
                            height *= MAX_WIDTH / width;
                            width = MAX_WIDTH;
                        }
                    } else {
                        if (height > MAX_HEIGHT) {
                            width *= MAX_HEIGHT / height;
                            height = MAX_HEIGHT;
                        }
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Compress to JPEG at 70% quality
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

                    let pics = await getDB('progressPictures', []);
                    pics.unshift({
                        id: Date.now().toString(),
                        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                        url: dataUrl
                    });
                    
                    await setDB('progressPictures', pics);
                    renderPhysiqueGallery();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        };

        // --- PATTERN LOCK FOR PHYSIQUE GALLERY ---
        window.patternLockState = { sequence: [], isDrawing: false, savedPattern: null };

        window.getPatternLockSaved = function() {
            const raw = localStorage.getItem('physiquePattern');
            return raw ? JSON.parse(raw) : null;
        };

        window.togglePhysiquePrivacy = function() {
            const saved = getPatternLockSaved();
            if (window.physiquePrivacy && saved) {
                // Show pattern lock overlay to unlock
                showPatternLock('unlock');
            } else if (window.physiquePrivacy && !saved) {
                // No pattern set — first time, prompt to set one
                showPatternLock('set');
            } else {
                // Re-lock
                window.physiquePrivacy = true;
                const gallery = document.getElementById('physique-gallery');
                const btn = document.getElementById('privacy-toggle-btn');
                gallery.classList.add('privacy-hidden');
                btn.innerText = '🙈 Hidden';
                btn.style.color = 'var(--text-muted)';
                btn.style.borderColor = 'var(--border)';
            }
        };

        window.showPatternLock = function(mode) {
            // mode: 'set' (first time), 'unlock' (verify), 'confirm' (confirm new pattern)
            const existing = document.getElementById('pattern-lock-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'pattern-lock-overlay';
            overlay.className = 'pattern-lock-overlay';

            const title = mode === 'set' ? 'SET PATTERN' : mode === 'confirm' ? 'CONFIRM PATTERN' : 'DRAW TO UNLOCK';
            const subtitle = mode === 'set' ? 'Draw a pattern to protect your photos' : mode === 'confirm' ? 'Draw the same pattern again' : '';

            overlay.innerHTML = `
                <div class="pattern-lock-modal">
                    <div class="pattern-lock-header">
                        <div class="pattern-lock-title">${title}</div>
                        <div class="pattern-lock-subtitle" id="pattern-subtitle">${subtitle}</div>
                    </div>
                    <div class="pattern-lock-grid" id="pattern-grid">
                        <svg class="pattern-lock-lines" id="pattern-lines" viewBox="0 0 240 240"></svg>
                        ${[0,1,2,3,4,5,6,7,8].map(i => {
                            const row = Math.floor(i / 3), col = i % 3;
                            const cx = col * 90 + 30, cy = row * 90 + 30;
                            return `<div class="pattern-dot" data-index="${i}" style="left:${cx - 20}px;top:${cy - 20}px;">
                                <div class="pattern-dot-inner"></div>
                                <div class="pattern-dot-ring"></div>
                            </div>`;
                        }).join('')}
                    </div>
                    <div class="pattern-lock-actions">
                        ${mode === 'set' || mode === 'confirm' ? '<button class="pattern-lock-btn pattern-lock-cancel" onclick="closePatternLock()">Cancel</button>' : '<button class="pattern-lock-btn pattern-lock-cancel" onclick="closePatternLock()">Cancel</button>'}
                        ${mode === 'set' || mode === 'confirm' ? '' : '<button class="pattern-lock-btn pattern-lock-reset" onclick="resetPatternLock()">Reset Pattern</button>'}
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            overlay.dataset.mode = mode;

            // Store first pattern for confirmation
            window.patternLockState.sequence = [];
            window.patternLockState.isDrawing = false;

            requestAnimationFrame(() => overlay.classList.add('visible'));
            setupPatternListeners();
        };

        window.setupPatternListeners = function() {
            const grid = document.getElementById('pattern-grid');
            if (!grid) return;
            const dots = grid.querySelectorAll('.pattern-dot');
            let activeSequence = [];
            let isDrawing = false;
            const lines = document.getElementById('pattern-lines');
            let liveLine = null;

            function getDotCenter(idx) {
                const row = Math.floor(idx / 3), col = idx % 3;
                return { x: col * 90 + 30, y: row * 90 + 30 };
            }

            function updateLines() {
                let svgContent = '';
                for (let i = 1; i < activeSequence.length; i++) {
                    const from = getDotCenter(activeSequence[i-1]);
                    const to = getDotCenter(activeSequence[i]);
                    svgContent += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" opacity="0.7"/>`;
                }
                if (liveLine) svgContent += liveLine;
                lines.innerHTML = svgContent;
            }

            function hitTest(x, y) {
                const rect = grid.getBoundingClientRect();
                const px = x - rect.left, py = y - rect.top;
                for (let i = 0; i < 9; i++) {
                    const c = getDotCenter(i);
                    const dx = px - c.x, dy = py - c.y;
                    if (Math.sqrt(dx*dx + dy*dy) < 30 && !activeSequence.includes(i)) {
                        return i;
                    }
                }
                return -1;
            }

            function activateDot(idx) {
                activeSequence.push(idx);
                dots[idx].classList.add('active');
                updateLines();
            }

            function onStart(e) {
                e.preventDefault();
                isDrawing = true;
                activeSequence = [];
                liveLine = null;
                dots.forEach(d => d.classList.remove('active', 'error', 'success'));
                lines.innerHTML = '';
                const subtitle = document.getElementById('pattern-subtitle');
                if (subtitle) { subtitle.textContent = ''; subtitle.classList.remove('error'); }

                const touch = e.touches ? e.touches[0] : e;
                const hit = hitTest(touch.clientX, touch.clientY);
                if (hit >= 0) activateDot(hit);
            }

            function onMove(e) {
                if (!isDrawing) return;
                e.preventDefault();
                const touch = e.touches ? e.touches[0] : e;
                const hit = hitTest(touch.clientX, touch.clientY);
                if (hit >= 0) activateDot(hit);

                // Live line from last dot to finger
                if (activeSequence.length > 0) {
                    const last = getDotCenter(activeSequence[activeSequence.length - 1]);
                    const rect = grid.getBoundingClientRect();
                    const px = touch.clientX - rect.left, py = touch.clientY - rect.top;
                    liveLine = `<line x1="${last.x}" y1="${last.y}" x2="${px}" y2="${py}" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" opacity="0.3"/>`;
                    updateLines();
                }
            }

            function onEnd(e) {
                if (!isDrawing) return;
                isDrawing = false;
                liveLine = null;
                updateLines();
                if (activeSequence.length < 3) {
                    showPatternError('Connect at least 3 dots');
                    return;
                }
                handlePatternComplete(activeSequence.slice());
            }

            grid.addEventListener('touchstart', onStart, { passive: false });
            grid.addEventListener('touchmove', onMove, { passive: false });
            grid.addEventListener('touchend', onEnd);
            grid.addEventListener('mousedown', onStart);
            grid.addEventListener('mousemove', onMove);
            grid.addEventListener('mouseup', onEnd);
        };

        window.showPatternError = function(msg) {
            const subtitle = document.getElementById('pattern-subtitle');
            if (subtitle) { subtitle.textContent = msg; subtitle.classList.add('error'); }
            const dots = document.querySelectorAll('#pattern-grid .pattern-dot.active');
            dots.forEach(d => { d.classList.add('error'); });
            const lines = document.getElementById('pattern-lines');
            if (lines) lines.querySelectorAll('line').forEach(l => l.setAttribute('stroke', 'var(--danger)'));
            setTimeout(() => {
                dots.forEach(d => d.classList.remove('active', 'error'));
                if (lines) lines.innerHTML = '';
                if (subtitle) subtitle.classList.remove('error');
            }, 600);
        };

        window.handlePatternComplete = function(seq) {
            const overlay = document.getElementById('pattern-lock-overlay');
            const mode = overlay ? overlay.dataset.mode : 'unlock';

            if (mode === 'set') {
                // Store temporarily for confirmation
                window.patternLockState.pendingPattern = seq;
                closePatternLock();
                setTimeout(() => showPatternLock('confirm'), 200);
            } else if (mode === 'confirm') {
                const pending = window.patternLockState.pendingPattern;
                if (pending && pending.join(',') === seq.join(',')) {
                    // Pattern confirmed — save it
                    localStorage.setItem('physiquePattern', JSON.stringify(seq));
                    closePatternLock();
                    unlockPhysique();
                } else {
                    showPatternError("Patterns don't match");
                }
            } else {
                // Unlock mode — verify against saved
                const saved = getPatternLockSaved();
                if (saved && saved.join(',') === seq.join(',')) {
                    // Success animation
                    const dots = document.querySelectorAll('#pattern-grid .pattern-dot.active');
                    dots.forEach(d => d.classList.add('success'));
                    const lines = document.getElementById('pattern-lines');
                    if (lines) lines.querySelectorAll('line').forEach(l => l.setAttribute('stroke', 'var(--teal)'));
                    setTimeout(() => { closePatternLock(); unlockPhysique(); }, 350);
                } else {
                    showPatternError('Wrong pattern');
                }
            }
        };

        window.unlockPhysique = function() {
            window.physiquePrivacy = false;
            const gallery = document.getElementById('physique-gallery');
            const btn = document.getElementById('privacy-toggle-btn');
            if (gallery) gallery.classList.remove('privacy-hidden');
            if (btn) {
                btn.innerText = '👁️ Revealed';
                btn.style.color = 'var(--accent)';
                btn.style.borderColor = 'var(--accent)';
            }
        };

        window.closePatternLock = function() {
            const overlay = document.getElementById('pattern-lock-overlay');
            if (overlay) {
                overlay.classList.remove('visible');
                setTimeout(() => overlay.remove(), 200);
            }
        };

        window.resetPatternLock = async function() {
            const confirmed = await showConfirm('Reset Pattern?', 'This will remove your current pattern lock. You will set a new one next time.', 'Reset', 'Cancel', true);
            if (confirmed) {
                localStorage.removeItem('physiquePattern');
                closePatternLock();
            }
        };

        window.renderPhysiqueGallery = async function() {
            const container = document.getElementById('physique-gallery');
            if (!container) return;

            // Enforce class on re-render just in case a new photo is uploaded
            if (window.physiquePrivacy) container.classList.add('privacy-hidden');
            else container.classList.remove('privacy-hidden');

            let pics = await getDB('progressPictures', []);
            
            if (pics.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-style: italic; font-size: 14px; text-align: center; padding: 20px; width: 100%;">No progress pictures added yet.</div>';
                return;
            }

            let html = '<div style="display: flex; gap: 12px; overflow-x: auto; padding-bottom: 15px; padding-top: 5px; width: 100%; scroll-snap-type: x mandatory; scrollbar-width: none; -ms-overflow-style: none;">';
            html += '<style>#physique-gallery div::-webkit-scrollbar { display: none; }</style>'; // Hide scrollbar for webkit
            
            pics.forEach(pic => {
                html += `
                <div style="position: relative; flex-shrink: 0; width: 140px; scroll-snap-align: start; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                    <img src="${pic.url}" style="width: 140px; height: 180px; object-fit: cover; border-radius: 12px; border: 1px solid var(--border); display: block;">
                    <div class="pic-date-label" style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(0,0,0,0.9), transparent); padding: 15px 8px 8px 8px; font-size: 11px; font-weight: 800; color: #fff; text-align: center; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; letter-spacing: 0.5px; transition: opacity 0.2s;">${pic.date}</div>
                    <button onclick="deleteProgressPicture('${pic.id}')" style="position: absolute; top: -6px; right: -6px; background: var(--danger); color: #fff; border: 2px solid var(--card); width: 26px; height: 26px; border-radius: 50%; font-size: 12px; font-weight: bold; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.5); z-index: 10;">✕</button>
                </div>`;
            });
            html += '</div>';
            
            container.innerHTML = html;
        };

        window.deleteProgressPicture = async function(id) {
            const confirmed = await showConfirm("Delete Picture?", "This will permanently remove this progress photo.", "Delete", "Cancel", true);
            if (confirmed) {
                let pics = await getDB('progressPictures', []);
                pics = pics.filter(p => p.id !== id);
                await setDB('progressPictures', pics);
                renderPhysiqueGallery();
            }
        };
        // ------------------------------------
        window.updateOfficialSBD = async function() {
            const confirmed = await showConfirm(
                "Lock Official Total?",
                "This will snapshot your current Squat, Bench Press, and Deadlift baselines and lock them in as your official SBD Total.",
                "Lock Total",
                "Cancel"
            );
            if (confirmed) {
                let global1RMs = safeParse('global1RMs', {});
                const newTotal = (global1RMs['Squat'] || 0) + (global1RMs['Bench Press'] || 0) + (global1RMs['Deadlift'] || 0);
                localStorage.setItem('officialSBDTotal', newTotal);
                renderStats();
            }
        };
        function rebuildPRHistoryFromWorkouts() {
            const history = workoutHistoryCache || [];
            if (history.length === 0) return;
            // One-time migration: wipe prHistory calculated with wrong RTS table
            if (!localStorage.getItem('prHistoryRTS_v2')) {
                localStorage.removeItem('prHistory');
                localStorage.setItem('prHistoryRTS_v2', '1');
            }
            const actualBests = safeParse('actualBests', {});
            const prHist = safeParse('prHistory', {});
            // Only rebuild for exercises missing prHistory
            const needsRebuild = Object.keys(actualBests).some(ex => !prHist[ex] || prHist[ex].length === 0);
            if (!needsRebuild) return;

            const rts = {
                10:[1.000,0.960,0.920,0.890,0.860,0.840,0.810,0.790,0.760,0.740,0.710,0.690],
                9.5:[0.980,0.940,0.910,0.880,0.850,0.820,0.800,0.770,0.750,0.720,0.690,0.670],
                9:[0.960,0.920,0.890,0.860,0.840,0.810,0.790,0.760,0.740,0.710,0.680,0.650],
                8.5:[0.940,0.910,0.880,0.850,0.820,0.800,0.770,0.750,0.720,0.690,0.670,0.640],
                8:[0.920,0.890,0.860,0.840,0.810,0.790,0.760,0.740,0.710,0.680,0.650,0.630],
                7.5:[0.910,0.880,0.850,0.820,0.800,0.770,0.750,0.720,0.690,0.670,0.640,0.610],
                7:[0.890,0.860,0.840,0.810,0.790,0.760,0.740,0.710,0.680,0.650,0.630,0.600],
                6.5:[0.880,0.850,0.820,0.800,0.770,0.750,0.720,0.690,0.670,0.640,0.610,0.580],
                6:[0.860,0.840,0.810,0.790,0.760,0.740,0.710,0.680,0.650,0.630,0.600,0.570],
                5.5:[0.850,0.820,0.800,0.770,0.750,0.720,0.690,0.670,0.640,0.610,0.580,0.550],
                5:[0.840,0.810,0.790,0.760,0.740,0.710,0.680,0.650,0.630,0.600,0.570,0.540]
            };
            const calcE1RM = (w, r, rpe) => {
                if (!w || w <= 0 || !r || r <= 0) return 0;
                let p = isNaN(rpe) || rpe < 0 || rpe > 10 ? 10 : rpe;
                let rounded = Math.round(p * 2) / 2;
                let rIdx = Math.max(0, Math.min(11, r - 1));
                let pct = rounded >= 5 ? rts[rounded][rIdx] : Math.max(0.1, rts[5][rIdx] - ((5 - rounded) * 0.025));
                return w / pct;
            };

            // Sort oldest-first
            const sorted = [...history].sort((a, b) => parseInt(a.id) - parseInt(b.id));
            const runningBest = {};
            const rebuilt = {};

            sorted.forEach(workout => {
                const ts = parseInt(workout.id) || Date.parse(workout.date) || 0;
                if (!workout.details) return;
                workout.details.forEach(ex => {
                    const exName = normalizeExName(ex.name);
                    if (!ex.sets) return;
                    ex.sets.forEach(set => {
                        const w = set.load || 0;
                        const r = set.reps || 0;
                        const rpe = parseFloat(set.rpe) || 10;
                        let effectiveW = w;
                        if (isBodyweightExercise(exName)) {
                            const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                            if (bw > 0) effectiveW += bw;
                        }
                        const e1rm = calcE1RM(effectiveW, r, rpe);
                        if (e1rm <= 0) return;
                        const cur = runningBest[exName];
                        const isBetter = !cur || (e1rm - cur.e1rm) > 0.01 || (Math.abs(e1rm - cur.e1rm) <= 0.01 && w > cur.weight);
                        if (isBetter) {
                            runningBest[exName] = { weight: w, reps: r, e1rm: parseFloat(e1rm.toFixed(1)), date: ts };
                            if (!rebuilt[exName]) rebuilt[exName] = [];
                            rebuilt[exName].push({ weight: w, reps: r, e1rm: parseFloat(e1rm.toFixed(1)), date: ts });
                        }
                    });
                });
            });

            // Fill in missing prHistory from rebuilt data
            let changed = false;
            Object.keys(actualBests).forEach(ex => {
                if ((!prHist[ex] || prHist[ex].length === 0) && rebuilt[ex]) {
                    prHist[ex] = rebuilt[ex].slice(-30);
                    changed = true;
                }
            });
            if (changed) {
                localStorage.setItem('prHistory', JSON.stringify(prHist));
            }
        }

        function renderStats() {
            rebuildPRHistoryFromWorkouts();
            const statsContainer = document.getElementById('stats-container');
            let global1RMs = safeParse('global1RMs', {});
            let actualBests = safeParse('actualBests', {});

            // --- AUTO-MIGRATION ALGORITHM ---
            // Collapses any legacy "Bench" or "Bench Press (Barbell)" into "Bench Press"
            let dataChanged = false;
            ['global1RMs', 'actualBests'].forEach(storeKey => {
                let store = storeKey === 'global1RMs' ? global1RMs : actualBests;
                Object.keys(store).forEach(key => {
                    const normKey = normalizeExName(key);
                    if (key !== normKey) {
                        if (storeKey === 'global1RMs') {
                            store[normKey] = Math.max(store[normKey] || 0, store[key]);
                        } else {
                            if (!store[normKey] || store[key].weight > store[normKey].weight || (store[key].weight === store[normKey].weight && store[key].reps > store[normKey].reps)) {
                                store[normKey] = store[key];
                            }
                        }
                        delete store[key];
                        dataChanged = true;
                    }
                });
            });
            if (dataChanged) {
                localStorage.setItem('global1RMs', JSON.stringify(global1RMs));
                localStorage.setItem('actualBests', JSON.stringify(actualBests));
            }
            // --------------------------------

            // Defaults
            if (!global1RMs['Squat']) global1RMs['Squat'] = 0;
            if (!global1RMs['Bench Press']) global1RMs['Bench Press'] = 0;
            if (!global1RMs['Deadlift']) global1RMs['Deadlift'] = 0;

            const savedBw = localStorage.getItem('userBodyweight') || '';
            const savedGender = localStorage.getItem('userGender') || 'M';

            // 1. SBD Total Math (always computed live from current 1RMs)
            const sbdTotal = (global1RMs['Squat'] || 0) + (global1RMs['Bench Press'] || 0) + (global1RMs['Deadlift'] || 0);
            
            let dotsScore = 0;
            if (savedBw && typeof calculateDOTS === 'function') {
                dotsScore = calculateDOTS(parseFloat(savedBw), sbdTotal, savedGender);
            } else if (savedBw && window.calculateDOTS) {
                dotsScore = window.calculateDOTS(parseFloat(savedBw), sbdTotal, savedGender);
            }

            const level = dotsLevel(dotsScore);
            const squat1RM  = global1RMs['Squat']       || 0;
            const bench1RM  = global1RMs['Bench Press'] || 0;
            const dead1RM   = global1RMs['Deadlift']    || 0;
            const currentUnit = getUnit();

            let html = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <h3 style="color:var(--text-main);font-size:18px;margin:0;">Lifter Profile</h3>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="unit-toggle-btn" onclick="window.toggleUnit()">${currentUnit === 'kg' ? 'kg → lbs' : 'lbs → kg'}</button>
                    <button style="background:var(--input-bg);border:1px solid var(--border);color:var(--text-muted);padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;" onclick="updateOfficialSBD()">↻ Lock Total</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
                <input type="number" class="input-box" style="width:70px;padding:8px;font-size:16px;" value="${savedBw}" placeholder="--" onchange="updateBodyweight(this.value)" inputmode="decimal">
                <span style="color:var(--text-muted);font-size:13px;font-weight:700;">kg BW</span>
                <select class="input-box" style="width:50px;padding:8px;font-size:14px;appearance:none;text-align:center;" onchange="updateGender(this.value)">
                    <option value="M" ${savedGender === 'M' ? 'selected' : ''}>M</option>
                    <option value="F" ${savedGender === 'F' ? 'selected' : ''}>F</option>
                </select>
            </div>
            <div class="dots-trophy-card" style="border-color:${level.color};color:${level.color};">
                <div class="dots-level-tag">${level.label}</div>
                <div class="dots-score-val" style="color:${level.color};">${dotsScore > 0 ? dotsScore : '--'}</div>
                <div class="dots-score-lbl">DOTS Score</div>
                <div class="dots-sbd-row">
                    <div class="dots-sbd-col"><span>Squat</span><strong style="color:var(--text-main);">${squat1RM > 0 ? kgDisp(squat1RM) : '--'}</strong></div>
                    <div class="dots-sbd-col"><span>Bench</span><strong style="color:var(--text-main);">${bench1RM > 0 ? kgDisp(bench1RM) : '--'}</strong></div>
                    <div class="dots-sbd-col"><span>Deadlift</span><strong style="color:var(--text-main);">${dead1RM > 0 ? kgDisp(dead1RM) : '--'}</strong></div>
                    <div class="dots-sbd-col"><span>Total</span><strong style="color:var(--accent);">${sbdTotal > 0 ? kgDisp(sbdTotal) : '--'}</strong></div>
                </div>
            </div>`;

            // ── Bodyweight history mini-chart ─────────────────────────────────
            const bwHist = safeParse('bwHistory', []).slice(-15).sort((a,b) => a.ts - b.ts);
            if (bwHist.length >= 2) {
                const bwVals = bwHist.map(e => currentUnit === 'lbs' ? e.w * 2.2046 : e.w);
                const bwMin = Math.min(...bwVals), bwMax = Math.max(...bwVals);
                const bwRange = bwMax - bwMin || 5;
                const cw = 320, ch = 60, pad = 10;
                const bwPts = bwVals.map((v, i) => {
                    const x = (i / (bwVals.length - 1)) * (cw - pad*2) + pad;
                    const y = ch - pad - ((v - bwMin) / bwRange) * (ch - pad*2);
                    return `${x},${y}`;
                }).join(' ');
                const fillPts = bwVals.map((v, i) => {
                    const x = (i / (bwVals.length - 1)) * (cw - pad*2) + pad;
                    const y = ch - pad - ((v - bwMin) / bwRange) * (ch - pad*2);
                    return `${x},${y}`;
                });
                fillPts.push(`${(cw-pad)},${ch-pad}`, `${pad},${ch-pad}`);
                html += `<div class="bw-chart-card">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <span style="font-size:12px;font-weight:800;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Bodyweight Trend</span>
                        <span style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--teal);">${parseFloat(bwVals[bwVals.length-1].toFixed(1))} ${currentUnit}</span>
                    </div>
                    <svg width="100%" viewBox="0 0 ${cw} ${ch}" style="overflow:visible;">
                        <defs><linearGradient id="bwFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#14b8a6" stop-opacity="0.3"/>
                            <stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/>
                        </linearGradient></defs>
                        <polygon points="${fillPts.join(' ')}" fill="url(#bwFill)"/>
                        <polyline points="${bwPts}" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>
                    </svg>
                </div>`;
            }

            html += '<h3 style="color: var(--text-main); font-size: 18px; margin-top: 30px; margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Current Baselines</h3>';
            html += '<p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">These 1RM values drive your percentage-based targets.</p>';

            // 2. Sort Baselines
            const all1RMKeys = Object.keys(global1RMs);
            const exactSBD = ['Squat', 'Bench Press', 'Deadlift'];
            let sorted1RMs = exactSBD.filter(k => all1RMKeys.includes(k));
            const other1RMs = all1RMKeys.filter(k => !exactSBD.includes(k)).sort();
            sorted1RMs = [...sorted1RMs, ...other1RMs];

            sorted1RMs.forEach(ex => {
                const safeExJS = ex.replace(/'/g, "\\'");
                const safeExHTML = ex.replace(/"/g, '&quot;');
                html += `
                <div class="swipe-wrapper stat-swipe">
                    <div class="swipe-delete-bg" style="right: 15px;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </div>
                    <div class="stat-card stat-swipable" style="padding: 12px 18px; margin-bottom: 0;" data-exname="${safeExHTML}">
                        <span class="stat-name" style="flex: 1; padding-right: 15px; word-break: break-word; line-height: 1.3;">${ex}</span>
                        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                            <input type="number" class="input-box" style="width: 80px; padding: 8px; font-size: 16px;" value="${global1RMs[ex] > 0 ? global1RMs[ex].toFixed(1) : ''}" placeholder="--" onchange="updateManual1RM('${safeExJS}', this.value)" inputmode="decimal">
                            <span style="color: var(--text-muted); font-size: 14px; font-weight: 600;">kg</span>
                        </div>
                    </div>
                </div>`;
            });

            html += '<h3 style="color:var(--text-main);font-size:18px;margin-top:40px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:8px;">All-Time Heaviest Lifts</h3>';

            // 3. Sort Bests
            const allBestKeys = Object.keys(actualBests);
            let sbdKeysBest = exactSBD.filter(k => allBestKeys.includes(k));
            const otherKeysBest = allBestKeys.filter(k => !exactSBD.includes(k)).sort();
            const bestKeys = [...sbdKeysBest, ...otherKeysBest];

            if (bestKeys.length === 0) {
                html += `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 0;color:var(--text-muted);">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                    <span style="font-size:13px;font-style:italic;">No completed sets yet. Your PRs will appear here.</span>
                </div>`;
            } else {
                // SBD achievement cards (3-column row)
                const sbdPresent = exactSBD.filter(k => allBestKeys.includes(k));
                if (sbdPresent.length > 0) {
                    html += '<div class="pr-sbd-row">';
                    sbdPresent.forEach(ex => {
                        const b = actualBests[ex];
                        const safeExHTML = ex.replace(/"/g, '&quot;');
                        const safeExJS = ex.replace(/'/g, "\\'");
                        html += `<div class="swipe-wrapper sbd-swipe">
                            <div class="swipe-delete-bg" style="right:8px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            </div>
                            <div class="pr-sbd-card stat-swipable" data-exname="${safeExHTML}" onclick="window.togglePRTimeline('${safeExJS}')">
                                <div class="pr-sbd-lift">${ex === 'Bench Press' ? 'Bench' : ex}</div>
                                <div class="pr-sbd-weight">${kgDisp(b.weight)}<span class="pr-sbd-unit"> ${unitSuffix()}</span></div>
                                <div class="pr-sbd-detail">× ${b.reps} rep${b.reps > 1 ? 's' : ''}</div>
                                <div class="pr-sbd-date">${b.date ? fmtShortDate(b.date) : ''}</div>
                            </div>
                        </div>`;
                    });
                    html += '</div>';
                    // PR timelines (hidden, one per SBD lift)
                    sbdPresent.forEach(ex => {
                        const tlId = 'prtl-' + encodeURIComponent(ex);
                        html += `<div class="pr-timeline" id="${tlId}" style="display:none;margin-bottom:10px;"></div>`;
                    });
                }

                // Non-SBD rows with date
                const nonSBD = otherKeysBest.filter(k => allBestKeys.includes(k));
                nonSBD.forEach(ex => {
                    const b = actualBests[ex];
                    const safeExHTML = ex.replace(/"/g, '&quot;');
                    const safeExJS   = ex.replace(/'/g, "\\'");
                    const tlId = 'prtl-' + encodeURIComponent(ex);
                    html += `
                    <div class="swipe-wrapper stat-swipe">
                        <div class="swipe-delete-bg" style="right:15px;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </div>
                        <div class="stat-card stat-swipable" style="padding:14px 18px;margin-bottom:0;flex-direction:column;align-items:stretch;gap:6px;cursor:pointer;" data-exname="${safeExHTML}" onclick="window.togglePRTimeline('${safeExJS}')">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span class="stat-name" style="flex:1;padding-right:10px;word-break:break-word;line-height:1.3;">${ex}</span>
                                <span class="stat-value" style="color:var(--teal);white-space:nowrap;">${kgDisp(b.weight)} ${unitSuffix()} <span style="font-size:13px;color:var(--text-muted);">× ${b.reps}</span></span>
                            </div>
                            <div class="pr-timeline" id="${tlId}" style="display:none;"></div>
                        </div>
                    </div>`;
                });
            }

            // Reset privacy lock every time the vault is opened
            window.physiquePrivacy = true;

            // Physique Tracking UI
            html += '<div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 40px; margin-bottom: 15px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">';
            html += '<h3 style="color: var(--text-main); font-size: 18px; margin: 0;">Physique Tracking</h3>';
            html += '<button id="privacy-toggle-btn" onclick="togglePhysiquePrivacy()" style="background: var(--input-bg); border: 1px solid var(--border); color: var(--text-muted); padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: 0.2s;">🙈 Hidden</button>';
            html += '</div>';
            html += '<p style="color: var(--text-muted); font-size: 13px; margin-bottom: 15px;">Locally stored progress pictures. These never leave your device.</p>';
            html += `
            <div id="physique-gallery" class="privacy-hidden" style="margin-bottom: 15px; min-height: 100px; display: flex; align-items: center; justify-content: center;">
                <div style="color: var(--text-muted); font-style: italic; font-size: 13px;">Loading gallery...</div>
            </div>
            <label class="action-btn" style="background: var(--input-bg); color: var(--text-main); border: 1px dashed var(--border); display: block; text-align: center; cursor: pointer; padding: 15px; font-size: 14px;">
                📸 Add Progress Picture
                <input type="file" accept="image/*" style="display:none;" onchange="handlePictureUpload(event)">
            </label>`;

            statsContainer.innerHTML = html;
            
            if (typeof setupStatsSwipe === 'function') setupStatsSwipe();
            if (typeof renderPhysiqueGallery === 'function') renderPhysiqueGallery();
        }

        async function exportData() {
            const backup = {
                activeWorkout: safeParse('activeWorkout', null),
                completedDays: safeParse('completedDays', {}),
                global1RMs: safeParse('global1RMs', {}),
                actualBests: safeParse('actualBests', {}),
                lastUsedWeights: safeParse('lastUsedWeights', {}),
                workoutHistory: workoutHistoryCache, // Pulls from the new infinite DB
                activeProgram: localStorage.getItem('activeProgram')
            };
            
            const jsonString = JSON.stringify(backup, null, 2);
            const fileName = `gomu_trainer_backup_${new Date().toISOString().split('T')[0]}.json`;

            try {
                // Try to trigger the Android Share menu (great for saving to Google Drive)
                if (navigator.share) {
                    const file = new File([jsonString], fileName, { type: 'text/plain' });
                    
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({
                            files: [file],
                            title: 'Gomu Trainer Backup'
                        });
                        return; // Success! Exit before the direct download triggers.
                    }
                }
            } catch (err) {
                // If you manually close the Share menu, stop the function.
                if (err.name === 'AbortError') return; 
            }

            // Standard Android Direct Download
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.href = url;
            downloadAnchorNode.download = fileName;
            document.body.appendChild(downloadAnchorNode); 
            downloadAnchorNode.click();
            document.body.removeChild(downloadAnchorNode);
            URL.revokeObjectURL(url);

            // Alert the user so it doesn't happen silently
            alert("Backup saved! Check your device's 'Downloads' folder.");
        }

        function importData(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    if (data.activeWorkout) localStorage.setItem('activeWorkout', JSON.stringify(data.activeWorkout));
                    if (data.completedDays) localStorage.setItem('completedDays', JSON.stringify(data.completedDays));
                    if (data.global1RMs) localStorage.setItem('global1RMs', JSON.stringify(data.global1RMs));
                    if (data.actualBests) localStorage.setItem('actualBests', JSON.stringify(data.actualBests));
                    if (data.lastUsedWeights) localStorage.setItem('lastUsedWeights', JSON.stringify(data.lastUsedWeights));
                    if (data.activeProgram) localStorage.setItem('activeProgram', data.activeProgram);
                    
                    if (data.workoutHistory) {
                        workoutHistoryCache = data.workoutHistory;
                        await setDB('workoutHistory', workoutHistoryCache);
                    }
                    
                    alert("Backup imported successfully! The app will now refresh.");
                    location.reload();
                } catch(err) {
                    alert("Error: Invalid backup file.");
                }
            };
            reader.readAsText(file);
        }

        window.openWarmupGenerator = function(exId, exName, isMain, scheme) {
            const firstLoadInput = document.querySelector(`input[id$="_load"][data-exid="${exId}"]`);
            const targetWeight = parseFloat(firstLoadInput.value);
            
            const firstRepsInput = firstLoadInput.closest('.set-row').querySelector('input[id$="_reps"]');
            const targetReps = firstRepsInput && firstRepsInput.value ? parseFloat(firstRepsInput.value) : 5;
            
            if (!targetWeight || targetWeight <= 0) {
                alert("⚠️ Please enter your working weight in the first set block before generating warmups!");
                return;
            }
            
            if (!scheme) scheme = isMain ? 5 : 2;

            document.getElementById('warmup-title').innerText = `${exName} Warm-up`;
            
            let html = `
                <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 15px;">
                    <button class="pill ${scheme === 5 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 5)" style="flex: 1; justify-content: center;">5 Sets</button>
                    <button class="pill ${scheme === 3 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 3)" style="flex: 1; justify-content: center;">3 Sets</button>
                    <button class="pill ${scheme === 2 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 2)" style="flex: 1; justify-content: center;">2 Sets</button>
                </div>
                <table class="warmup-table" style="margin-bottom: 20px; text-align: center; width: 100%; border-collapse: collapse;">
                    <tr>
                        <th style="padding-bottom: 10px; color: var(--text-muted); font-size: 11px; text-transform: uppercase;">Set</th>
                        <th style="padding-bottom: 10px; color: var(--text-muted); font-size: 11px; text-transform: uppercase;">Load</th>
                        <th style="padding-bottom: 10px; color: var(--text-muted); font-size: 11px; text-transform: uppercase;">Reps</th>
                    </tr>
            `;
            
            let sets = [];
            const roundToPlate = (w) => roundForEquipment(w, exName);

            const wReps1 = targetReps >= 8 ? 4 : 1;
            const wReps2 = targetReps >= 8 ? 5 : 2;
            const wReps3 = targetReps >= 8 ? 6 : 3;

            if (scheme === 5) {
                sets = [
                    { label: targetWeight > 20 ? "Bar" : "Light", load: targetWeight > 20 ? 20 : roundToPlate(targetWeight*0.3), reps: Math.max(10, targetReps) },
                    { load: roundToPlate(targetWeight * 0.4), reps: Math.max(5, wReps3) },
                    { load: roundToPlate(targetWeight * 0.6), reps: wReps3 },
                    { load: roundToPlate(targetWeight * 0.75), reps: wReps2 },
                    { load: roundToPlate(targetWeight * 0.85), reps: wReps1 }
                ];
            } else if (scheme === 3) {
                sets = [
                    { label: targetWeight > 20 ? "Bar" : "Light", load: targetWeight > 20 ? 20 : roundToPlate(targetWeight*0.4), reps: Math.max(8, wReps3 + 2) },
                    { load: roundToPlate(targetWeight * 0.6), reps: wReps3 },
                    { load: roundToPlate(targetWeight * 0.8), reps: wReps1 }
                ];
            } else {
                sets = [
                    { load: roundToPlate(targetWeight * 0.5), reps: Math.max(6, targetReps - 2) },
                    { load: roundToPlate(targetWeight * 0.75), reps: Math.max(3, wReps1 + 1) }
                ];
            }

            // Beautiful Plate Badge Generator
            const getPlateBadges = (weight) => {
                const eqMode = typeof getEquipmentMode === 'function' ? getEquipmentMode(exName) : 'bb';

                // For 2DB: show per-dumbbell weight with a dumbbell icon
                if (eqMode === '2db') {
                    const perDb = Math.round((weight / 2) * 10) / 10;
                    return `<div style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 4px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9" width="3" height="6" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/><rect x="5" y="7" width="3" height="10" rx="1"/><rect x="16" y="7" width="3" height="10" rx="1"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                        <span style="font-size: 10px; color: var(--text-muted); font-weight: 800;">${perDb}kg each</span>
                    </div>`;
                }

                // For non-BB modes: no badges
                if (eqMode !== 'bb') return '';

                let barWeight = typeof getBarbellWeight === 'function' ? getBarbellWeight() : 20;
                if (weight <= barWeight) return `<div style="font-size: 9px; color: var(--text-muted); font-weight: 700; margin-top: 3px;">Empty Bar</div>`;

                let perSide = (weight - barWeight) / 2;
                perSide = Math.round(perSide * 100) / 100;

                const available = typeof getActivePlates === 'function' ? getActivePlates().filter(p => p.active).sort((a, b) => b.w - a.w) : [
                    {w: 25, c: '#ef4444', t: '#fff'}, {w: 20, c: '#3b82f6', t: '#fff'}, {w: 15, c: '#eab308', t: '#000'},
                    {w: 10, c: '#22c55e', t: '#fff'}, {w: 5, c: '#f4f4f5', t: '#000'}, {w: 2.5, c: '#27272a', t: '#fff'}, {w: 1.25, c: '#52525b', t: '#fff'}
                ];

                let plates = [];
                for (let p of available) {
                    while (perSide >= p.w) {
                        plates.push(p);
                        perSide = Math.round((perSide - p.w) * 100) / 100;
                    }
                }

                if (plates.length === 0) return '';

                let badges = `<div style="display: flex; gap: 3px; align-items: center; justify-content: center; margin-top: 4px;">`;
                plates.forEach(p => {
                    badges += `<div style="background: ${p.c}; color: ${p.t}; font-size: 8px; font-weight: 800; padding: 2px 4px; border-radius: 3px; line-height: 1; border: 1px solid rgba(0,0,0,0.3); box-shadow: 0 1px 2px rgba(0,0,0,0.2);">${p.w}</div>`;
                });
                if (perSide > 0.01) {
                    badges += `<div style="font-size: 9px; color: var(--text-muted); font-weight: 700; margin-left: 2px;">+${parseFloat(perSide.toFixed(2))}</div>`;
                }
                badges += `</div>`;
                return badges;
            };

            sets.forEach((s, i) => {
                let displayLoad = s.label || `${Math.max(0, s.load)} kg`;
                let badges = s.label ? '' : getPlateBadges(s.load);
                html += `
                <tr style="border-top: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 10px 0; font-size: 14px; font-weight: 600;">${i + 1}</td>
                    <td style="padding: 10px 0;">
                        <div style="color: var(--accent); font-weight: 800; font-size: 16px;">${displayLoad}</div>
                        ${badges}
                    </td>
                    <td style="padding: 10px 0; font-size: 15px; font-weight: 700;">${s.reps}</td>
                </tr>`;
            });
            
            // Work Set Target row
            let workBadges = getPlateBadges(targetWeight);
            html += `
                <tr style="border-top: 1px dashed var(--accent); background: rgba(249, 115, 22, 0.05);">
                    <td style="padding: 12px 0; font-size: 12px; font-weight: 800; color: var(--accent);">WORK</td>
                    <td style="padding: 12px 0;">
                        <div style="color: #fff; font-weight: 900; font-size: 16px;">${targetWeight} kg</div>
                        ${workBadges}
                    </td>
                    <td style="padding: 12px 0; font-size: 15px; font-weight: 700;">${targetReps}</td>
                </tr>
            </table>`;
            
            html += `
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button class="action-btn" style="background: var(--input-bg); color: var(--text-main); margin: 0; padding: 10px 16px; font-size: 14px; width: auto;" onclick="document.getElementById('warmup-modal').style.display = 'none'">Close</button>
                    <button class="action-btn btn-start" style="margin: 0; padding: 10px 24px; font-size: 14px; width: auto;" onclick="completeWarmup()">Done</button>
                </div>
            `;
            
            document.getElementById('warmup-modal-content').innerHTML = html;
            document.getElementById('warmup-modal').style.display = 'flex';
        };

        window.completeWarmup = function() {
            document.getElementById('warmup-modal').style.display = 'none';
            startTimer(120); // Starts the 2 minute rest
        };

        window.closeWarmupModal = function(e) {
            if (e.target.id === 'warmup-modal') e.target.style.display = 'none';
        };
        window.colorizeRpe = function(input) {
            input.style.color = '';
        };
        // --- E1RM TREND INDICATOR ---
        // Compares best e1RM across recent sessions to detect adaptation or fatigue
        function getRpeDrift(exName) {
            const history = safeParse('workoutHistory', []);
            const rts = {
                10:  [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                9.5: [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                9:   [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                8.5: [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                8:   [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                7.5: [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                7:   [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                6.5: [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                6:   [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                5.5: [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                5:   [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
            };
            const calcE1RM = (load, reps, rpe) => {
                if (!load || load <= 0 || !reps || reps <= 0) return 0;
                let r = parseFloat(rpe); if (isNaN(r) || r < 0 || r > 10) r = 10;
                let rounded = Math.round(r * 2) / 2; if (rounded < 5) rounded = 5;
                return load / rts[rounded][Math.max(0, Math.min(11, reps - 1))];
            };

            // Collect best e1RM per session, most-recent first (up to 6 sessions)
            let sessions = [];
            for (const log of history) {
                if (!log.details) continue;
                const ex = log.details.find(e => e.name === exName);
                if (!ex || !ex.sets || ex.sets.length === 0) continue;
                const best = Math.max(...ex.sets.map(s => calcE1RM(s.load, s.reps, s.rpe)));
                if (best > 0) sessions.push(best);
                if (sessions.length >= 6) break;
            }
            if (sessions.length < 2) return null;

            // Compare average e1RM of recent half vs older half
            const mid = Math.ceil(sessions.length / 2);
            const recentAvg = sessions.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
            const olderAvg = sessions.slice(mid).reduce((a, b) => a + b, 0) / (sessions.length - mid);
            const pct = (recentAvg - olderAvg) / olderAvg * 100;

            // Threshold: ±2% e1RM change is meaningful
            if (pct >= 2) return { dir: 'up', label: 'Adapting', delta: pct };
            if (pct <= -2) return { dir: 'down', label: 'Fatiguing', delta: pct };
            return { dir: 'stable', label: 'Stable', delta: pct };
        }

        function renderWorkout() {
            const container = document.getElementById('workout-container');
            container.innerHTML = '';
            renderWarmupList();
            
            document.getElementById('workout-program-title').innerText = db[currentProgram]?.name || "Workout";
            
            // 1. Define all our states FIRST so the app doesn't crash
            const currentKey = getWorkoutKey();
            const isCompleted = completedDays[currentKey];
            const isActive = activeWorkout && activeWorkout.key === currentKey;
            const isPreview = !isCompleted && !isActive;

            // 2. DECLARED ONLY ONCE: Check if it is a Custom Program
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');

            // 3. Hide Program Management tab for Custom Workouts
            const pmCard = document.getElementById('program-management-card');
            if (pmCard) {
                pmCard.style.display = isCustomProgram ? 'none' : 'block';
            }

            // 4. Hide Week/Day pills for Custom Workouts
            document.querySelectorAll('.pill-scroll-container').forEach(pContainer => {
                pContainer.style.display = isCustomProgram ? 'none' : 'block';
            });

            // 5. Handle Empty states & On-the-Fly modifications safely
            let exercises = getActiveExercises(currentProgram, selectedWeek, selectedDay, currentKey);
            const activeCount = exercises.filter(ex => !ex.isDeleted).length;
            
            if (activeCount === 0 && !isCustomProgram) {
                container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Rest Day / No Data Available</div>';
                return;
            }

            let topActionUI = '';
            let bottomActionUI = '';

            if (isCompleted) {
                if (isCustomProgram) {
                    topActionUI = `
                        <div class="status-header" style="flex-direction: column; gap: 15px;">
                            <span style="color:#22c55e; font-weight:800; font-size: 15px;">✅ Workout Completed</span>
                            <button class="action-btn" style="background: var(--teal); color: #000; margin: 0; padding: 12px;" onclick="restartCustomWorkout()">▶ Run Template Again</button>
                        </div>`;
                } else {
                    topActionUI = `
                        <div class="status-header">
                            <span style="color:#22c55e; font-weight:800; font-size: 15px;">✅ Workout Completed</span>
                        </div>`;
                }
            } else if (isActive) {
            bottomActionUI = `
            <div style="text-align: center; margin-bottom: 5px; margin-top: 10px; color: var(--text-muted); font-size: 10px; font-weight: 800; opacity: 0.6; letter-spacing: 1px;">
                <span style="color: var(--danger);">◀ SWIPE TO CANCEL</span> &nbsp;&nbsp;|&nbsp;&nbsp; <span style="color: var(--teal);">SLIDE TO FINISH ▶</span>
            </div>
            <div class="swipe-wrapper" id="stop-swipe-wrapper" style="margin-bottom: 60px; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.3); background: var(--danger);">
                <div class="swipe-delete-bg" style="right: 25px; opacity: 1; flex-direction: row; gap: 6px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    <span style="font-size: 13px; font-weight: 800; letter-spacing: 1px; margin-top: 0;">CANCEL</span>
                </div>
                <div class="slider-container" id="finish-slider" style="margin: 0; width: 100%; position: relative; z-index: 2; transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1); touch-action: pan-y;">
                    <div class="slider-track" id="slider-track"></div>
                    <div class="slider-thumb" id="slider-thumb">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
                    </div>
                    <div class="slider-text" style="width: calc(100% - 64px); left: 64px; font-size: 14px;">Slide to Finish</div>
                </div>
            </div>`;
            } else {
                topActionUI = `<button class="action-btn btn-start" onclick="toggleWorkoutState('start')">▶ Start Workout</button>`;
            }

            let html = topActionUI + `<div class="${(isPreview || isCompleted) ? 'preview-mode' : ''}">`;

            const savedSession = safeParse(currentKey, {});
            const lastUsedWeights = safeParse('lastUsedWeights', {});

            // --- REORDER ENGINE ---
            let displayExercises = exercises.map((ex, origIdx) => ({ ...ex, origIdx }));
            if (savedSession.customOrder) {
                let orderMap = new Map();
                savedSession.customOrder.forEach((origIdx, pos) => orderMap.set(origIdx, pos));
                displayExercises.sort((a, b) => {
                    let posA = orderMap.has(a.origIdx) ? orderMap.get(a.origIdx) : 999 + a.origIdx;
                    let posB = orderMap.has(b.origIdx) ? orderMap.get(b.origIdx) : 999 + b.origIdx;
                    return posA - posB;
                });
            }

            displayExercises.forEach((ex, displayIndex) => {
                const exIndex = ex.origIdx; // CRITICAL: Preserves data bindings!
                if (ex.isDeleted) return; 
                
                const exId = `ex-${exIndex}`;
                const isMain = ex.type === 'main';
                const nameLower = ex.name.toLowerCase();
                const isMyo = ex.notes ? ex.notes.toLowerCase().includes('myo') : false; 
                const isSupersetNext = ex.supersetNext && displayIndex < displayExercises.length - 1;
                
                let logoSvg = '';
                if (nameLower.includes('squat')) {
                    logoSvg = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><rect x="2" y="5" width="2" height="4"/><rect x="20" y="5" width="2" height="4"/><circle cx="15" cy="4" r="1.5"/><path d="M14 7l-3 6"/><path d="M11 13h5"/><path d="M16 13l-2 7"/><path d="M14 20h2"/></svg>`;
                } else if (nameLower.includes('bench')) {
                    logoSvg = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15h18"/><path d="M6 15v4"/><path d="M18 15v4"/><path d="M4 9h16"/><rect x="2" y="7" width="2" height="4"/><rect x="20" y="7" width="2" height="4"/><path d="M12 15v-4"/><path d="M10 11l-2 -3"/><path d="M14 11l2 -3"/></svg>`;
                } else if (nameLower.includes('deadlift')) {
                    logoSvg = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18h16"/><rect x="2" y="16" width="2" height="4"/><rect x="20" y="16" width="2" height="4"/><path d="M12 18v-6"/><path d="M9 10h6"/><path d="M10 12l-2 -4"/><path d="M14 12l2 -4"/></svg>`;
                } else if (isMain) {
                    logoSvg = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"/><rect x="2" y="10" width="2" height="4"/><rect x="20" y="10" width="2" height="4"/></svg>`;
                } else {
                    logoSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5h11v11h-11z" transform="rotate(45 12 12)"/><path d="M8 8l8 8"/><path d="M3 3l3 3"/><path d="M18 18l3 3"/></svg>`;
                }

                const resolved1RM = getResolved1RM(ex.name);
                const historical1RM = resolved1RM > 0 ? `Ref 1RM: ${resolved1RM.toFixed(1)}kg` : '1RM --';

                // RPE Drift indicator
                let driftHtml = '';
                const drift = getRpeDrift(ex.name);
                if (drift) {
                    const arrow = drift.dir === 'up' ? '↑' : drift.dir === 'down' ? '↓' : '—';
                    const color = drift.dir === 'up' ? 'var(--teal)' : drift.dir === 'down' ? 'var(--danger)' : 'var(--text-muted)';
                    const delta = Math.abs(drift.delta).toFixed(1) + '%';
                    driftHtml = `<span style="margin-left:auto; font-size:11px; font-weight:800; color:${color}; display:inline-flex; align-items:center; gap:3px; letter-spacing:0.5px;">${arrow} ${drift.label} <span style="opacity:0.7; font-weight:600;">(${delta})</span></span>`;
                }

                const notesHtml = ex.notes ? `<div class="coach-notes">${ex.notes}</div>` : ''; 
                const liftClass = isMain ? 'main-lift' : 'acc-lift';
                
                const warmupColor = isMain ? 'var(--accent)' : 'var(--teal)';
                const warmupSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
                const timerSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"></circle><polyline points="12 9 12 13 14 15"></polyline><line x1="12" y1="2" x2="12" y2="4"></line><line x1="9" y1="2" x2="15" y2="2"></line></svg>`;

                const isNonExercise = /rest|information|info|note/i.test(ex.name);

                // NEW: Swipe-to-delete wrapper for Custom Workouts
                let wrapperStart = '';
                let wrapperEnd = '';
                let swipeClass = '';
                let dataIdx = '';
                
                if (!isCompleted) {
                    wrapperStart = `
                    <div class="swipe-wrapper" id="swipe-wrapper-${exId}" style="margin-bottom: ${isSupersetNext ? '8px' : '16px'};">
                        <div class="swipe-delete-bg">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                            <span>DELETE</span>
                        </div>`;
                    wrapperEnd = `</div>`;
                    swipeClass = 'swipable';
                    dataIdx = `data-exindex="${exIndex}"`;
                }

                // Safely encode the notes so newlines and quotes don't break the HTML!
                    // Safely encode the notes so newlines and quotes don't break the HTML!
                    const safeNotes = encodeURIComponent((ex.notes || '').replace(/'/g, "%27"));

                    // NEW: Smart Note Display Logic
                    let displayNotesHtml = '';
                    if (!isNonExercise) {
                        if (ex.notes) {
                            // Note exists: Show it with a pencil icon
                            displayNotesHtml = `<div class="coach-notes" onclick="openNoteModal(${exIndex}, decodeURIComponent('${safeNotes}'))" style="cursor:pointer;" title="Tap to edit">✎ ${ex.notes}</div>`;
                        } else if (!isCompleted) {
                            // No note yet: Show a subtle "Add Note" button
                            displayNotesHtml = `<div class="coach-notes" onclick="openNoteModal(${exIndex}, '')" style="cursor:pointer; opacity: 0.4; font-size: 13px;">+ Add Note</div>`;
                        }
                    }

                    html += `
                    ${wrapperStart}
                    <div class="exercise-container ${liftClass} ${swipeClass}" id="${exId}" ${dataIdx}>
                        <div class="ex-title-container">
                            
                            ${isNonExercise ? '' : `
                            <button class="btn-warmup-icon" 
                                    style="left: 16px; right: auto; border-color: ${warmupColor}; color: ${warmupColor}; display: flex; align-items: center; justify-content: center; padding: 5px 8px;" 
                                    onclick="openSwapModal(${exIndex}, '${ex.name.replace(/'/g, "\\'")}')" title="Swap Exercise">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/></svg>
                            </button>
                            `}
                            
                            <h2 class="ex-title" onclick="${!isNonExercise ? `openHistoryOverlay('${ex.name.replace(/'/g, "\\'")}')` : ''}" style="${isNonExercise ? 'padding: 0 10px; text-align: center; width: 100%;' : 'cursor:pointer; width: 100%; padding-bottom: 2px;'}">
                                ${ex.name}
                            </h2>
                            
                            ${isNonExercise ? '' : `
                            <button class="btn-warmup-icon" 
                                    style="border-color: ${warmupColor}; color: ${warmupColor}; display: flex; align-items: center; justify-content: center; padding: 5px 8px;" 
                                    onclick="openWarmupGenerator('${exId}', '${ex.name.replace(/'/g, "\\'")}', ${isMain})">
                                ${warmupSvg}
                            </button>
                            `}
                        </div>

                        ${!isNonExercise ? (() => {
                            const eqMode = getEquipmentMode(ex.name);
                            const safeExJS = ex.name.replace(/'/g, "\\'");
                            const labels = {bb:'BB', '1db':'1DB', '2db':'2DB', cable:'Cable'};
                            return `<div style="text-align:center;padding:2px 0;"><button class="eq-cycle-chip" onclick="cycleEquipmentMode('${safeExJS}')">${labels[eqMode]}</button></div>`;
                        })() : ''}

                        ${displayNotesHtml}

                        ${!isNonExercise ? `<div class="global-e1rm" id="global-e1rm-${exId}" style="display:flex; align-items:center; justify-content:center; gap:8px;"><span>${historical1RM}</span>${driftHtml}</div>` : ''}
                    `;

                const numBlocks = ex.blocks.length;

                ex.blocks.forEach((block, bIndex) => {
                    let details = [];
                    if (block.pct) details.push(`${(block.pct * 100).toFixed(0)}%`);
                    if (block.targetRpe) details.push(`RPE ${block.targetRpe.toFixed(1)}`);
                    const detailsStr = details.length > 0 ? ` @ ${details.join(' | ')}` : '';
                    const dotColor = isMain ? '#f97316' : '#14b8a6';
                    
                    // SMART DETECTION: Activations are always the first block, OR any single set with 8+ reps
                    const isMyoActivation = isMyo && (bIndex === 0 || (block.sets === 1 && block.reps >= 8));
                    const isMyoBackoff = isMyo && !isMyoActivation;
                    
                    if (isMyoBackoff) {
                        // VISUAL LINK FOR MYO-REP BACK-OFFS
                        html += `
                        <div class="block-container" style="padding-top: 0; margin-top: -15px; position: relative;">
                            <div style="position: absolute; left: 35px; top: -10px; bottom: 30px; width: 2px; background: repeating-linear-gradient(to bottom, ${dotColor} 0, ${dotColor} 4px, transparent 4px, transparent 8px); opacity: 0.5;"></div>
                            <div style="padding: 8px 16px 12px 45px; color: var(--text-muted); font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${dotColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>
                                Myo-Rep Back-offs (${block.sets} x ${block.reps})
                            </div>
                        `;
                    } else {
                        // STANDARD BLOCK HEADER
                        html += `
                        <div class="block-container">
                            <div class="block-header">
                                <span><span style="color: ${dotColor}; margin-right: 8px; font-size: 18px; line-height: 0;">●</span> ${block.sets} x ${block.reps} Reps${detailsStr}</span>
                            </div>
                            <div class="set-row header">
                                <span>Set</span>
                                <span>Reps</span>
                                <span onclick="openRpeHub()" style="cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 4px; line-height: 1;" title="RPE Guide">
                                    RPE 
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 1px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                </span>
                                <span>Load</span>
                                <span>e1RM</span>
                                <span></span>
                            </div>
                        `;
                    }

                    let restSeconds = 120;
                    if (isMain) {
                        if (block.type === 'top') {
                            restSeconds = (numBlocks > 2) ? 240 : 210; 
                        } else if (block.type === 'backoff') {
                            if (numBlocks > 2) {
                                restSeconds = (bIndex === 1) ? 180 : 120; 
                            } else {
                                restSeconds = 150; 
                            }
                        } else if (block.type === 'work') {
                            restSeconds = 180; 
                        }
                    } else {
                        restSeconds = 90; 
                    }

                    // --- DRAW STANDARD SETS AND THEIR EXTRAS ---
                    for(let s = 1; s <= block.sets; s++) {
                        let smartDefaultLoad = '';
                        if (block.pct && resolved1RM > 0) {
                            smartDefaultLoad = roundForEquipment(resolved1RM * block.pct, ex.name);
                        } else if (block.targetRpe && resolved1RM > 0) {
                            // SMART RPE PRE-LOAD: Calculates exact starting weight based on Target RPE
                            const rtsChart = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };
                            let rRoundedRpe = Math.round(block.targetRpe * 2) / 2;
                            let rRepIndex = Math.max(0, Math.min(11, block.reps - 1));
                            
                            let targetPct = 0;
                            if (rRoundedRpe >= 5) {
                                targetPct = rtsChart[rRoundedRpe][rRepIndex];
                            } else {
                                targetPct = Math.max(0.1, rtsChart[5][rRepIndex] - ((5 - rRoundedRpe) * 0.025));
                            }
                            
                            if (targetPct > 0) {
                                let calcWeight = roundForEquipment(resolved1RM * targetPct, ex.name);
                                if (isBodyweightExercise(ex.name)) {
                                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                                    if (bw > 0) calcWeight = Math.max(0, calcWeight - bw);
                                }
                                smartDefaultLoad = calcWeight;
                            }
                        } else if (lastUsedWeights[ex.name]) {
                            // Fallback to memory if neither PCT nor Target RPE exist
                            if (typeof lastUsedWeights[ex.name] === 'object' && lastUsedWeights[ex.name] !== null) {
                                smartDefaultLoad = lastUsedWeights[ex.name][`_b${bIndex}_s${s}`] || lastUsedWeights[ex.name].fallback || '';
                            } else {
                                smartDefaultLoad = lastUsedWeights[ex.name]; 
                            }
                        }

                        const rowId = `${exId}_b${bIndex}_s${s}`;
                        const repsInputId = `${rowId}_reps`; 
                        const rpeInputId = `${rowId}_rpe`;
                        const loadInputId = `${rowId}_load`;
                        const checkId = `${rowId}_check`;
                        
                        const repsValue = savedSession[repsInputId] || block.reps;
                        const rpeValue = savedSession[rpeInputId] || (block.targetRpe ? block.targetRpe.toFixed(1) : '');
                        const loadValue = savedSession[loadInputId] || smartDefaultLoad || '';
                        
                        const isChecked = savedSession[checkId] ? 'checked' : '';
                        const disabledAttr = isChecked ? 'disabled' : '';

                        let e1rmCell = `<span><button class="e1rm-btn" id="e1rm-btn-${rowId}" data-exid="${exId}" data-exname="${ex.name}" data-rowid="${rowId}" data-e1rm="0"><span class="e1rm-label">Calc</span><span class="e1rm-value">--</span></button></span>`;

                        const repsClass = 'input-box saveable calc-trigger'; 
                        const rpeClass = 'input-box input-rpe saveable calc-trigger';
                        const loadClass = `input-box saveable calc-trigger ${isMain ? 'main-load' : 'acc-load'}`;

                        let setHtml = `
                        <div class="set-row">
                            <span>${s}</span>
                            <span><input type="number" id="${repsInputId}" class="${repsClass}" data-rowid="${rowId}" value="${repsValue}" inputmode="numeric" ${disabledAttr}></span>
                            <span><input type="number" id="${rpeInputId}" class="${rpeClass}" data-rowid="${rowId}" data-targetrpe="${block.targetRpe || ''}" value="${rpeValue}" step="0.5" inputmode="decimal" oninput="if(window.colorizeRpe) window.colorizeRpe(this)" ${disabledAttr}></span>
                            <span style="position:relative; display:flex; align-items:center; justify-content:center; width: 100%;">
                                <input type="number" id="${loadInputId}" class="${loadClass}" data-rowid="${rowId}" data-pct="${block.pct || ''}" data-exname="${ex.name}" data-exid="${exId}" value="${loadValue}" placeholder="kg" inputmode="decimal" style="width: 100%;" ${disabledAttr}>
                                ${getEquipmentMode(ex.name) !== 'bb' ? '' : `
                                <button class="plate-btn" onclick="togglePlateBalloon(event, '${loadInputId}')" title="Calculate Plates">
                                    <div class="plate-indicator"></div>
                                </button>`}
                            </span>
                            ${e1rmCell}
                            <span class="check-circle ${isChecked}" id="${checkId}" data-rest="${restSeconds}" ${isSupersetNext ? 'data-superset="true"' : ''} ${isMyoActivation ? 'data-myotype="activation"' : ''} ${isMyoBackoff ? 'data-myotype="backoff"' : ''} onclick="toggleCheck(this)"></span>
                        </div>
                        `;

                        // Wrap it in the Swipe-to-delete wrapper if the workout is active
                        if (!isCompleted) {
                            html += `
                            <div class="swipe-wrapper set-swipe">
                                <div class="swipe-delete-bg" style="right: 15px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
                                <div class="set-swipable" data-exindex="${exIndex}" data-bindex="${bIndex}" data-setnum="${s}">
                                    ${setHtml}
                                </div>
                            </div>`;
                        } else {
                            html += setHtml;
                        }

                        // NEW: Immediately draw any extra target sets spawned by THIS specific set
                        const extrasKey = `extras_${exIndex}_${bIndex}_s${s}`;
                        const extrasArray = savedSession[extrasKey] || [];
                        
                        extrasArray.forEach((extraData, eIdx) => {
                            const extraRowId = `${rowId}_extra_${eIdx}`;
                            const eRepsValue = savedSession[`${extraRowId}_reps`] || extraData.reps;
                            const eRpeValue = savedSession[`${extraRowId}_rpe`] || extraData.rpe;
                            const eLoadValue = savedSession[`${extraRowId}_load`] || extraData.weight;
                            const eIsChecked = savedSession[`${extraRowId}_check`] ? 'checked' : '';
                            const eDisabledAttr = eIsChecked ? 'disabled' : '';
                            
                            const themeColor = isMain ? 'var(--accent)' : 'var(--teal)';

                            const isLatestExtra = (eIdx === extrasArray.length - 1);
                            const canDismiss = isLatestExtra && !eIsChecked;
                            const setLabel = canDismiss ?
                                `<button class="target-dismiss-chip" style="--tc:${themeColor};" onclick="event.stopPropagation();dismissTargetSet(${exIndex},${bIndex},'s${s}',${eIdx})">SKIP</button>` :
                                isLatestExtra ?
                                `<span style="color: ${themeColor}; font-size: 11px; line-height: 1; text-align: center; font-weight:800;">TARGET<br>SET</span>` :
                                `<span>${s}.${eIdx + 1}</span>`;
                                
                            const borderStyle = isLatestExtra ? `border: 1px dashed ${themeColor};` : `border: 1px solid transparent;`;

                            html += `
                            <div class="set-row" style="${borderStyle} margin-top: 8px;">
                                ${setLabel}
                                <span><input type="number" id="${extraRowId}_reps" class="input-box saveable calc-trigger" data-rowid="${extraRowId}" value="${eRepsValue}" inputmode="numeric" ${eDisabledAttr}></span>
                                <span><input type="number" id="${extraRowId}_rpe" class="input-box saveable calc-trigger input-rpe" style="opacity: ${eDisabledAttr ? '0.6' : '1'};" data-rowid="${extraRowId}" data-targetrpe="${extraData.rpe || ''}" value="${eRpeValue}" step="0.5" inputmode="decimal" oninput="if(window.colorizeRpe) window.colorizeRpe(this)" ${eDisabledAttr}></span>
                                <span style="position:relative; display:flex; align-items:center; justify-content:center; width: 100%;">
                                    <input type="number" id="${extraRowId}_load" class="input-box saveable calc-trigger ${isMain ? 'main-load' : 'acc-load'}" data-rowid="${extraRowId}" data-exname="${ex.name}" data-exid="${exId}" value="${eLoadValue}" placeholder="kg" inputmode="decimal" style="width: 100%;" ${eDisabledAttr}>
                                    ${getEquipmentMode(ex.name) !== 'bb' ? '' : `
                                    <button class="plate-btn" onclick="togglePlateBalloon(event, '${extraRowId}_load')" title="Calculate Plates">
                                        <div class="plate-indicator"></div>
                                    </button>`}
                                </span>
                                <span><button class="e1rm-btn" id="e1rm-btn-${extraRowId}" data-exid="${exId}" data-exname="${ex.name}" data-rowid="${extraRowId}" data-e1rm="0"><span class="e1rm-label">Calc</span><span class="e1rm-value">--</span></button></span>
                                <span class="check-circle ${eIsChecked}" id="${extraRowId}_check" data-rest="${restSeconds}" ${isSupersetNext ? 'data-superset="true"' : ''} ${isMyoActivation ? 'data-myotype="activation"' : ''} ${isMyoBackoff ? 'data-myotype="backoff"' : ''} onclick="toggleCheck(this)"></span>
                            </div>`;
                        });
                    }
                    
                    // NEW: Add Set Button at the bottom of the block
                    if (!isCompleted) {
                        html += `<div style="text-align: center; margin-top: 4px; margin-bottom: 16px;">
                                    <button class="pill" style="margin: 0 auto; padding: 6px 14px; font-size: 11px; background: transparent; border: 1px dashed var(--border);" onclick="addSetToBlock(${exIndex}, ${bIndex})">+ Add Set</button>
                                 </div>`;
                    }
                    
                    html += `</div>`; // Close block-container
                });
                html += `</div>`;
                html += wrapperEnd; // Close the swipe wrapper
                
                // --- SUPERSET CONTROLS ---
                if (!isCompleted && displayIndex < displayExercises.length - 1) {
                    const linkColor = isSupersetNext ? '#fff' : 'var(--text-muted)';
                    const borderColor = isSupersetNext ? '#fff' : 'var(--border)';
                    const linkGlow = isSupersetNext ? '0 0 10px rgba(255,255,255,0.3)' : '0 4px 10px rgba(0,0,0,0.5)';
                    const linkOpacity = isSupersetNext ? '1' : '0.5';
                    
                    html += `
                    <div style="display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 0px; margin-bottom: ${isSupersetNext ? '8px' : '16px'}; position: relative; z-index: 10;">
                        <button onclick="toggleSuperset(${exIndex})" style="background: var(--card); border: 2px solid ${borderColor}; color: ${linkColor}; opacity: ${linkOpacity}; border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; box-shadow: ${linkGlow};" title="Link as Superset">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                        </button>
                    </div>`;
                }
            });
            
            html += `</div>`; // CLOSE THE PREVIEW WRAPPER FIRST!
            
            // Show Add Exercise & Reorder for ANY uncompleted workout
            if (!isCompleted) {
                html += `
                <div style="display: flex; gap: 12px; margin-top: 20px; margin-bottom: 20px;">
                    <button class="action-btn" style="flex: 1; background: rgba(255,255,255,0.05); color: var(--text-main); border: 1px dashed var(--border); margin: 0; padding: 15px; font-size: 14px;" onclick="document.getElementById('add-exercise-modal').style.display='flex'">+ Add</button>
                    <button class="action-btn" style="flex: 1; background: rgba(255,255,255,0.05); color: var(--text-main); border: 1px dashed var(--border); margin: 0; padding: 15px; font-size: 14px;" onclick="openReorderModal()">⇅ Reorder</button>
                </div>`;
            }
            
            html += bottomActionUI;
            
            container.innerHTML = html;
            attachListeners();
            
            // Initialize swipe logic for ANY uncompleted workout
            if (!isCompleted) {
                setupSwipeToDelete();
            }
            if (isActive) {
                setupSlider(); 
                if (typeof startWorkoutTimer === 'function') startWorkoutTimer();
            } else {
                if (typeof workoutDurationInterval !== 'undefined') clearInterval(workoutDurationInterval);
                const timerEl = document.getElementById('workout-duration');
                if (timerEl) timerEl.style.display = 'none';
            }
            
            // Init RPE colors
            document.querySelectorAll('.input-rpe').forEach(el => {
                if (typeof window.colorizeRpe === 'function') window.colorizeRpe(el);
            });
        }

        function setupSlider() {
            const thumb = document.getElementById('slider-thumb');
            const track = document.getElementById('slider-track');
            const container = document.getElementById('finish-slider');
            if(!thumb || !container) return;
            
            let isDraggingThumb = false;
            let isDraggingContainer = false;
            let isScrolling = false;
            let startX = 0, startY = 0;
            let maxSlide = 0; 

            // --- THUMB LOGIC (Slide Right to Finish) ---
            const onThumbStart = (e) => {
                isDraggingThumb = true;
                maxSlide = container.offsetWidth - 76; 
                startX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                thumb.style.transition = 'none';
                track.style.transition = 'none';
                thumb.classList.add('dragging');
                track.classList.add('dragging');
            };

            const onThumbMove = (e) => {
                if (!isDraggingThumb) return;
                if (e.cancelable) e.preventDefault(); 
                
                let currentX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                let diff = currentX - startX;
                
                if (diff < 0) diff = 0;
                if (diff > maxSlide) diff = maxSlide;
                
                thumb.style.transform = `translateX(${diff}px)`;
                track.style.width = `${diff + 76}px`;
                
                const text = container.querySelector('.slider-text');
                if (text) text.style.opacity = 1 - (diff / maxSlide);

                if (diff >= maxSlide - 5) {
                    isDraggingThumb = false;
                    thumb.classList.remove('dragging');
                    track.classList.remove('dragging');
                    toggleWorkoutState('finish');
                }
            };

            const onThumbEnd = () => {
                if (!isDraggingThumb) return;
                isDraggingThumb = false;
                thumb.classList.remove('dragging');
                track.classList.remove('dragging');
                thumb.style.transition = 'transform 0.3s ease';
                track.style.transition = 'width 0.3s ease';
                thumb.style.transform = `translateX(0px)`;
                track.style.width = `0%`;
                const text = container.querySelector('.slider-text');
                if (text) text.style.opacity = 1;
            };

            thumb.addEventListener('touchstart', onThumbStart, {passive: true});
            document.addEventListener('touchmove', onThumbMove, {passive: false});
            document.addEventListener('touchend', onThumbEnd);
            document.addEventListener('touchcancel', onThumbEnd);
            
            thumb.addEventListener('mousedown', onThumbStart);
            document.addEventListener('mousemove', onThumbMove, {passive: false});
            document.addEventListener('mouseup', onThumbEnd);
            
            // --- CONTAINER LOGIC (Swipe Left to Stop) ---
            const onContainerStart = (e) => {
                if (e.target.closest('#slider-thumb')) return; 
                isDraggingContainer = true;
                isScrolling = false;
                startX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                startY = e.type.includes('mouse') ? e.clientY : (e.touches ? e.touches[0].clientY : 0);
                container.style.transition = 'none';
            };
            
            const onContainerMove = (e) => {
                if (!isDraggingContainer) return;
                let currentX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                let currentY = e.type.includes('mouse') ? e.clientY : (e.touches ? e.touches[0].clientY : 0);
                let diffX = currentX - startX;
                let diffY = Math.abs(currentY - startY);
                
                if (!isScrolling && diffY > 10 && diffY > Math.abs(diffX)) isScrolling = true;
                if (isScrolling) return;
                
                if (diffX < 0) {
                    if (e.cancelable) e.preventDefault();
                    container.style.transform = `translateX(${diffX}px)`;
                }
            };
            
            const onContainerEnd = (e) => {
                if (!isDraggingContainer) return;
                isDraggingContainer = false;
                container.style.transition = 'transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)';
                
                let currentX = e.type.includes('mouse') ? e.clientX : (e.changedTouches ? e.changedTouches[0].clientX : 0);
                let diffX = currentX - startX;
                
                if (!isScrolling && diffX < -100) {
                    container.style.transform = `translateX(-100%)`;
                    setTimeout(() => {
                        container.style.transform = `translateX(0px)`;
                        cancelActiveWorkout();
                    }, 200);
                } else {
                    container.style.transform = `translateX(0px)`;
                }
            };
            
            container.addEventListener('touchstart', onContainerStart, {passive: true});
            container.addEventListener('touchmove', onContainerMove, {passive: false});
            container.addEventListener('touchend', onContainerEnd);
            container.addEventListener('touchcancel', onContainerEnd);
            
            container.addEventListener('mousedown', onContainerStart);
            container.addEventListener('mousemove', onContainerMove);
            container.addEventListener('mouseup', onContainerEnd);
            container.addEventListener('mouseleave', onContainerEnd);
        }

        function setupSwipeToDelete() {
            const bindSwipe = (el, threshold, onTrigger) => {
                let startX = 0, startY = 0, currentX = 0, isDragging = false, isScrolling = false;
                
                const startDrag = (e) => {
                    if (e.target.tagName.toLowerCase() === 'input' || e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
                    
                    // Elegantly prevents the parent exercise from swiping when you are dragging a child set!
                    if (el.classList.contains('exercise-container') && e.target.closest('.set-swipable')) return;
                    
                    startX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                    startY = e.type.includes('mouse') ? e.clientY : (e.touches ? e.touches[0].clientY : 0);
                    isDragging = true; isScrolling = false;
                    el.classList.add('swiping');
                };
                
                const moveDrag = (e) => {
                    if (!isDragging) return;
                    
                    let clientX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                    let clientY = e.type.includes('mouse') ? e.clientY : (e.touches ? e.touches[0].clientY : 0);
                    let diffX = clientX - startX;
                    let diffY = Math.abs(clientY - startY);
                    
                    if (!isScrolling && diffY > 10 && diffY > Math.abs(diffX)) isScrolling = true;
                    if (isScrolling) return;
                    
                    currentX = diffX;
                    if (currentX < 0) {
                        if (e.cancelable) e.preventDefault();
                        el.style.transform = `translateX(${currentX}px)`;
                    }
                };
                
                const endDrag = (e) => {
                    if (!isDragging) return;
                    isDragging = false;
                    el.classList.remove('swiping');
                    if (!isScrolling && currentX < threshold) {
                        el.style.transform = `translateX(-100%)`;
                        setTimeout(onTrigger, 200);
                    } else {
                        el.style.transform = `translateX(0px)`;
                    }
                    currentX = 0;
                };
                
                el.addEventListener('touchstart', startDrag, {passive: true});
                el.addEventListener('touchmove', moveDrag, {passive: false});
                el.addEventListener('touchend', endDrag);
                el.addEventListener('mousedown', startDrag);
                el.addEventListener('mousemove', moveDrag);
                el.addEventListener('mouseup', endDrag);
                el.addEventListener('mouseleave', endDrag);
            };

            document.querySelectorAll('.exercise-container.swipable').forEach(el => {
                bindSwipe(el, -100, () => deleteCustomExercise(parseInt(el.dataset.exindex)));
            });
            
            document.querySelectorAll('.set-swipable').forEach(el => {
                bindSwipe(el, -80, () => deleteSetFromBlock(parseInt(el.dataset.exindex), parseInt(el.dataset.bindex), parseInt(el.dataset.setnum)));
            });
        }

        window.deleteCustomExercise = async function(exIndex) {
            const confirmed = await showConfirm("Delete Exercise?", "Remove this exercise from your workout?", "Delete", "Cancel", true);
            if (!confirmed) { renderWorkout(); return; }
            
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            if (isCustomProgram) {
                db[currentProgram].weeks[selectedWeek][selectedDay].splice(exIndex, 1);
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                const baseLen = db[currentProgram]?.weeks[selectedWeek]?.[selectedDay]?.length || 0;
                
                if (exIndex >= baseLen) {
                    if (!savedSession.addedExercises) savedSession.addedExercises = [];
                    savedSession.addedExercises[exIndex - baseLen].isDeleted = true;
                } else {
                    if (!savedSession.deletedIndices) savedSession.deletedIndices = [];
                    savedSession.deletedIndices.push(exIndex);
                }
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            renderWorkout(); 
        };

        window.openSwapModal = function(exIndex, exName) {
            window.swapTargetExIndex = exIndex;
            document.getElementById('swap-ex-name').value = '';
            document.getElementById('swap-exercise-modal').style.display = 'flex';
        };

        window.submitSwapExercise = function() {
            const newName = document.getElementById('swap-ex-name').value.trim();
            if (!newName) return;
            
            const exIndex = window.swapTargetExIndex;
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            
            if (isCustomProgram) {
                db[currentProgram].weeks[selectedWeek][selectedDay][exIndex].name = newName;
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                if (!savedSession.swappedNames) savedSession.swappedNames = {};
                savedSession.swappedNames[exIndex] = newName;
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            
            document.getElementById('swap-exercise-modal').style.display = 'none';
            renderWorkout();
        };
        window.toggleSuperset = function(exIndex) {
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            
            if (isCustomProgram) {
                const ex = db[currentProgram].weeks[selectedWeek][selectedDay][exIndex];
                ex.supersetNext = !ex.supersetNext;
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                if (!savedSession.supersets) savedSession.supersets = {};
                // Toggle the boolean state
                savedSession.supersets[exIndex] = !savedSession.supersets[exIndex];
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            
            renderWorkout();
        };

        window.openReorderModal = function() {
            const key = getWorkoutKey();
            const savedSession = safeParse(key, {});
            let exercises = getActiveExercises(currentProgram, selectedWeek, selectedDay, key);
            
            let displayExercises = exercises.map((ex, origIdx) => ({ ...ex, origIdx }));
            if (savedSession.customOrder) {
                let orderMap = new Map();
                savedSession.customOrder.forEach((origIdx, pos) => orderMap.set(origIdx, pos));
                displayExercises.sort((a, b) => {
                    let posA = orderMap.has(a.origIdx) ? orderMap.get(a.origIdx) : 999 + a.origIdx;
                    let posB = orderMap.has(b.origIdx) ? orderMap.get(b.origIdx) : 999 + b.origIdx;
                    return posA - posB;
                });
            }

            const listContainer = document.getElementById('reorder-list');
            let html = '';
            
            displayExercises.forEach(ex => {
                if (ex.isDeleted) return;
                html += `
                <div class="reorder-item" data-origidx="${ex.origIdx}">
                    <span style="flex: 1; pointer-events: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 10px;">${ex.name}</span>
                    <div class="drag-handle">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
                    </div>
                </div>`;
            });
            
            listContainer.innerHTML = html;
            document.getElementById('reorder-modal').style.display = 'flex';
            setupReorderDrag();
        };

        window.saveReorder = function() {
            const listContainer = document.getElementById('reorder-list');
            const items = listContainer.querySelectorAll('.reorder-item');
            let newOrder = [];
            
            items.forEach(item => {
                newOrder.push(parseInt(item.dataset.origidx));
            });
            
            const key = getWorkoutKey();
            let savedSession = safeParse(key, {});
            savedSession.customOrder = newOrder;
            localStorage.setItem(key, JSON.stringify(savedSession));
            
            document.getElementById('reorder-modal').style.display = 'none';
            renderWorkout();
        };

        function setupReorderDrag() {
            const list = document.getElementById('reorder-list');
            if(!list) return;

            if (window.onReorderMoveHandler) {
                document.removeEventListener('mousemove', window.onReorderMoveHandler);
                document.removeEventListener('mouseup', window.onReorderEndHandler);
                document.removeEventListener('touchmove', window.onReorderMoveHandler);
                document.removeEventListener('touchend', window.onReorderEndHandler);
            }

            let draggingEle = null;
            let placeholder = null;
            let startY = 0;
            let offsetTop = 0;

            const onStart = (e) => {
                if (!e.target.closest('.drag-handle')) return;
                draggingEle = e.target.closest('.reorder-item');
                
                const rect = draggingEle.getBoundingClientRect();
                const listRect = list.getBoundingClientRect();
                
                startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                // Calculate position relative to the scrollable container
                offsetTop = rect.top - listRect.top + list.scrollTop;
                
                // 1. Create a perfectly sized invisible placeholder to hold the layout open
                placeholder = document.createElement('div');
                placeholder.className = 'reorder-item';
                placeholder.style.visibility = 'hidden';
                placeholder.style.height = rect.height + 'px';
                placeholder.style.margin = '0 0 8px 0'; // Matches CSS margin
                
                // 2. Insert placeholder exactly where the item started
                list.insertBefore(placeholder, draggingEle);
                
                // 3. Float the dragging element above everything else
                // We don't use the hollow class, instead we manually lift it with a shadow
                draggingEle.style.position = 'absolute';
                draggingEle.style.top = offsetTop + 'px';
                draggingEle.style.left = '0px'; 
                draggingEle.style.margin = '0';
                draggingEle.style.width = '100%';
                draggingEle.style.boxSizing = 'border-box';
                draggingEle.style.zIndex = '1000';
                draggingEle.style.background = 'var(--card)';
                draggingEle.style.borderColor = 'var(--accent)';
                draggingEle.style.boxShadow = '0 10px 25px rgba(0,0,0,0.8)';
                
                // Lock the parent container relative so the floating item stays inside
                list.style.position = 'relative';

                if (e.cancelable) e.preventDefault();
            };

            window.onReorderMoveHandler = (e) => {
                if (!draggingEle) return;
                if (e.cancelable) e.preventDefault();
                
                const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
                const diffY = clientY - startY;
                
                // Move the floating element
                draggingEle.style.transform = `translateY(${diffY}px)`;
                
                // Temporarily hide the floating item to see what our finger is hovering over
                draggingEle.style.visibility = 'hidden';
                const target = document.elementFromPoint(e.type.includes('mouse') ? e.clientX : e.touches[0].clientX, clientY);
                draggingEle.style.visibility = 'visible';
                
                if (!target) return;
                const targetItem = target.closest('.reorder-item');
                
                // If we cross halfway over another item, physically swap the placeholder's DOM location!
                if (targetItem && targetItem !== draggingEle && targetItem !== placeholder) {
                    const targetRect = targetItem.getBoundingClientRect();
                    const mid = targetRect.top + targetRect.height / 2;
                    if (clientY < mid) {
                        list.insertBefore(placeholder, targetItem);
                    } else {
                        list.insertBefore(placeholder, targetItem.nextSibling);
                    }
                }
            };

            window.onReorderEndHandler = () => {
                if (!draggingEle) return;
                
                // 4. Snap the floating element permanently into the placeholder's location
                list.insertBefore(draggingEle, placeholder);
                placeholder.remove();
                
                // 5. Clean up all inline styles so the DOM returns to normal
                draggingEle.style.position = '';
                draggingEle.style.top = '';
                draggingEle.style.left = '';
                draggingEle.style.margin = '';
                draggingEle.style.width = '';
                draggingEle.style.boxSizing = '';
                draggingEle.style.zIndex = '';
                draggingEle.style.transform = '';
                draggingEle.style.background = '';
                draggingEle.style.borderColor = '';
                draggingEle.style.boxShadow = '';
                
                draggingEle = null;
                placeholder = null;
            };

            list.addEventListener('touchstart', onStart, {passive: false});
            list.addEventListener('mousedown', onStart);
            
            document.addEventListener('touchmove', window.onReorderMoveHandler, {passive: false});
            document.addEventListener('touchend', window.onReorderEndHandler);
            document.addEventListener('mousemove', window.onReorderMoveHandler, {passive: false});
            document.addEventListener('mouseup', window.onReorderEndHandler);
        }

        window.openNoteModal = function(exIndex, currentNote) {
            window.noteTargetExIndex = exIndex;
            document.getElementById('edit-note-text').value = currentNote && currentNote !== 'undefined' ? currentNote : '';
            document.getElementById('edit-note-modal').style.display = 'flex';
        };

        window.submitEditNote = function() {
            const newNote = document.getElementById('edit-note-text').value.trim();
            const exIndex = window.noteTargetExIndex;
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            
            if (isCustomProgram) {
                db[currentProgram].weeks[selectedWeek][selectedDay][exIndex].notes = newNote;
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                if (!savedSession.modifiedNotes) savedSession.modifiedNotes = {};
                savedSession.modifiedNotes[exIndex] = newNote;
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            
            document.getElementById('edit-note-modal').style.display = 'none';
            renderWorkout();
        };

        window.openHistoryOverlay = function(exName) {
            document.getElementById('history-overlay-title').innerText = exName;
            const content = document.getElementById('history-overlay-content');
            
            let history = safeParse('workoutHistory', []);
            let foundSessions = [];
            
            // Scan history for the last 3 times this exercise was performed
            for (let log of history) {
                let exMatch = log.details.find(e => e.name === exName);
                if (exMatch && exMatch.sets.length > 0) {
                    foundSessions.push({
                        date: log.date,
                        weight: Math.max(...exMatch.sets.map(s => s.load)),
                        sets: exMatch.sets
                    });
                }
                if (foundSessions.length >= 3) break;
            }
            
            if (foundSessions.length === 0) {
                content.innerHTML = '<p style="color: var(--text-muted); text-align: center; font-style: italic; margin-top: 30px;">No previous logs found for this exercise.</p>';
            } else {
                let html = '';
                foundSessions.forEach(session => {
                    html += `
                    <div style="background: #1e1e20; border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px dashed #3f3f46; padding-bottom: 8px;">
                            <span style="color: var(--accent); font-weight: 800; font-size: 13px; text-transform: uppercase;">${session.date}</span>
                            <span style="color: #fff; font-weight: 800; font-size: 13px;">Top: ${session.weight}kg</span>
                        </div>`;
                    session.sets.forEach((s, i) => {
                        let rpeText = s.rpe ? `<span style="color:var(--text-muted); font-size:12px;">@${s.rpe}</span>` : '';
                        html += `
                        <div style="display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px; color: var(--text-main);">
                            <span style="color: var(--text-muted); font-weight: 600;">Set ${i+1}</span>
                            <span style="font-weight: 700;">${s.load}kg x ${s.reps} ${rpeText}</span>
                        </div>`;
                    });
                    html += `</div>`;
                });
                content.innerHTML = html;
            }
            
            const overlay = document.getElementById('history-overlay');
            overlay.style.display = 'flex';
            // Slight delay allows the CSS transition to fire smoothly
            setTimeout(() => overlay.classList.add('open'), 10);
        };

        window.closeHistoryOverlay = function() {
            const overlay = document.getElementById('history-overlay');
            overlay.classList.remove('open');
            setTimeout(() => overlay.style.display = 'none', 300);
        };

        window.closeHistoryOverlay = function() {
            const overlay = document.getElementById('history-overlay');
            overlay.classList.remove('open');
            setTimeout(() => overlay.style.display = 'none', 300);
        };
        // --- GYM INVENTORY ENGINE ---
        function getActivePlates() {
            let saved = safeParse('gymPlateInventory', null);
            if (!saved) {
                // Default IPF standard plates
                saved = [
                    {w: 25, c: '#ef4444', t: '#fff', active: true},
                    {w: 20, c: '#3b82f6', t: '#fff', active: true},
                    {w: 15, c: '#eab308', t: '#000', active: true},
                    {w: 10, c: '#22c55e', t: '#fff', active: true},
                    {w: 5, c: '#f4f4f5', t: '#000', active: true},
                    {w: 2.5, c: '#27272a', t: '#fff', active: true},
                    {w: 1.25, c: '#52525b', t: '#fff', active: true}
                ];
                localStorage.setItem('gymPlateInventory', JSON.stringify(saved));
            }
            return saved;
        }

        function getBarbellWeight() {
            return parseFloat(localStorage.getItem('gymBarbellWeight')) || 20;
        }

        window.updateBarbellWeight = function(val) {
            let w = parseFloat(val);
            if (!isNaN(w) && w >= 0) {
                localStorage.setItem('gymBarbellWeight', w);
            }
        };

        window.openPlateSettings = function(e) {
            e.stopPropagation();
            
            // Force the balloon to close immediately so it doesn't overlap the modal
            const balloon = document.getElementById('plate-balloon');
            if (balloon) {
                balloon.style.display = 'none';
                balloon.dataset.activeInput = '';
            }

            const plates = getActivePlates();
            
            // Set the barbell input to your saved value
            const barInput = document.getElementById('settings-bar-weight');
            if (barInput) barInput.value = getBarbellWeight();

            const container = document.getElementById('plate-toggles-container');
            container.innerHTML = plates.map((p, i) => `
                <div style="display: flex; justify-content: space-between; align-items: center; background: var(--input-bg); padding: 10px 15px; border-radius: 8px; border: 1px solid var(--border);">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div class="plate-block" style="background: ${p.c}; color: ${p.t}; width: 28px; text-align: center; font-size: 12px;">${p.w}</div>
                        <span style="font-weight: 700; color: var(--text-main); font-size: 14px;">kg Plate</span>
                    </div>
                    <input type="checkbox" ${p.active ? 'checked' : ''} onchange="togglePlateInventory(${i}, this.checked)" style="width: 20px; height: 20px; accent-color: var(--accent); cursor: pointer;">
                </div>
            `).join('');
            
            document.getElementById('plate-settings-modal').style.display = 'flex';
        };

        window.togglePlateInventory = function(idx, isActive) {
            let plates = getActivePlates();
            plates[idx].active = isActive;
            localStorage.setItem('gymPlateInventory', JSON.stringify(plates));
        };

        window.closePlateSettings = function() {
            document.getElementById('plate-settings-modal').style.display = 'none';
            // Force close the balloon so it recalculates fresh on next tap
            const balloon = document.getElementById('plate-balloon');
            if (balloon) { balloon.style.display = 'none'; balloon.dataset.activeInput = ''; }
        };
        // --- NEW: PLATE CALCULATOR ENGINE ---
        window.togglePlateBalloon = function(e, loadInputId) {
            e.stopPropagation();
            const balloon = document.getElementById('plate-balloon');
            const input = document.getElementById(loadInputId);
            
            // Toggle off if tapping the same active button
            if (balloon.dataset.activeInput === loadInputId && balloon.style.display === 'flex') {
                balloon.style.display = 'none';
                balloon.dataset.activeInput = '';
                return;
            }

            if (!input || !input.value) return;

            const weight = parseFloat(input.value);
            if (isNaN(weight) || weight <= 0) return;

            let html = '';
            let barWeight = getBarbellWeight();
            
            if (weight < barWeight) {
                html = `<div style="position: absolute; top: 6px; right: 8px; padding: 4px; cursor: pointer; color: var(--text-muted); font-size: 14px;" onclick="openPlateSettings(event)" title="Settings">⚙️</div>
                        <div style="font-weight: 800; color: var(--accent); font-size: 14px; margin-top: 6px;">${weight}kg</div>
                        <div style="font-size: 11px; color: var(--text-muted); font-weight: 700;">Dumbbell / Plate</div>`;
            } else if (weight === barWeight) {
                html = `<div style="position: absolute; top: 6px; right: 8px; padding: 4px; cursor: pointer; color: var(--text-muted); font-size: 14px;" onclick="openPlateSettings(event)" title="Settings">⚙️</div>
                        <div style="font-weight: 800; color: var(--accent); font-size: 14px; margin-top: 6px;">Empty Bar</div>
                        <div style="font-size: 11px; color: var(--text-muted); font-weight: 700;">${barWeight}kg</div>`;
            } else {
                let perSide = (weight - barWeight) / 2;
                let plates = [];
                
                // Float precision fix so weird numbers don't break the loop
                perSide = Math.round(perSide * 100) / 100; 

                const available = getActivePlates().filter(p => p.active).sort((a, b) => b.w - a.w);

                for (let p of available) {
                    while (perSide >= p.w) {
                        plates.push(p);
                        perSide = Math.round((perSide - p.w) * 100) / 100;
                    }
                }
                
                html = `<div style="position: absolute; top: 6px; right: 8px; padding: 4px; cursor: pointer; color: var(--text-muted); font-size: 14px; z-index: 10;" onclick="openPlateSettings(event)" title="Settings">⚙️</div>
                        <div style="font-size: 10px; color: var(--text-muted); margin-bottom: -10px; font-weight: 800; text-transform: uppercase; padding-right: 15px; text-align: center;">Per Side (${barWeight}kg Bar)</div>
                        
                        <div style="display: flex; align-items: center; justify-content: flex-start; max-width: 100%; overflow-x: auto; padding: 25px 5px; scrollbar-width: none;">
                            <div style="width: 14px; height: 10px; background: #52525b; border-radius: 2px 0 0 2px; flex-shrink: 0;"></div>
                            <div style="width: 7px; height: 28px; background: #a1a1aa; border-radius: 2px; flex-shrink: 0; box-shadow: inset 2px 0 4px rgba(0,0,0,0.3); z-index: 2;"></div>
                            <div style="display: flex; align-items: center; height: 10px; background: #71717a; border-radius: 0 4px 4px 0; padding-left: 1px; padding-right: 15px; min-width: 25px;">`;
                
                // Draw dynamic plates!
                plates.forEach((p, i) => {
                    let h = p.w >= 20 ? 54 : p.w >= 15 ? 46 : p.w >= 10 ? 36 : p.w >= 5 ? 26 : p.w >= 2.5 ? 20 : 16;
                    let w = p.w >= 10 ? 14 : 10;
                    let f = p.w >= 10 ? 9 : 8;
                    html += `<div class="plate-anim" style="animation-delay: ${i * 60}ms; width: ${w}px; height: ${h}px; background: ${p.c}; border-radius: 2px; border: 1px solid rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; margin-right: 1px; flex-shrink: 0; box-shadow: inset -1px 0 3px rgba(0,0,0,0.3); z-index: 3;">
                                <span style="font-size: ${f}px; font-weight: 800; color: ${p.t}; transform: rotate(-90deg); letter-spacing: -0.5px;">${p.w}</span>
                             </div>`;
                });
                
                if (perSide > 0.01) {
                    html += `<div style="margin-left: 8px; font-size: 11px; color: var(--text-muted); font-weight: 700; white-space: nowrap;">+${parseFloat(perSide.toFixed(2))}kg</div>`;
                }
                
                html += `   </div>
                        </div>`;
            }

            balloon.innerHTML = html;
            balloon.dataset.activeInput = loadInputId;
            balloon.style.display = 'flex';
            balloon.style.animation = 'none';
            balloon.offsetHeight; // reflow trigger to re-fire animation
            balloon.style.animation = '';

            // Smart Positioning (Centers directly above the button you clicked)
            const rect = e.currentTarget.getBoundingClientRect();
            const top = rect.top + window.scrollY - balloon.offsetHeight - 14;
            const left = rect.left + window.scrollX + (rect.width / 2);

            balloon.style.top = `${top}px`;
            balloon.style.left = `${left}px`;
        };

        // Close balloon when clicking anywhere else on the screen
        document.addEventListener('click', (e) => {
            const balloon = document.getElementById('plate-balloon');
            if (balloon && !e.target.closest('.plate-btn')) {
                balloon.style.display = 'none';
                balloon.dataset.activeInput = '';
            }
        });
        // ------------------------------------

        window.addSetToBlock = function(exIndex, bIndex) {
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            if (isCustomProgram) {
                db[currentProgram].weeks[selectedWeek][selectedDay][exIndex].blocks[bIndex].sets++;
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                if (!savedSession.modifiedBlocks) savedSession.modifiedBlocks = {};
                
                const bKey = `${exIndex}_${bIndex}`;
                let currentSets = savedSession.modifiedBlocks[bKey];
                if (currentSets === undefined) {
                    const baseEx = getActiveExercises(currentProgram, selectedWeek, selectedDay, key)[exIndex];
                    currentSets = baseEx.blocks[bIndex].sets;
                }
                
                savedSession.modifiedBlocks[bKey] = currentSets + 1;
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            renderWorkout();
        };

        window.deleteSetFromBlock = async function(exIndex, bIndex, setNum) {
            const confirmed = await showConfirm("Delete Set?", "Remove this set from the block?", "Delete", "Cancel", true);
            if (!confirmed) { renderWorkout(); return; }

            const key = getWorkoutKey();
            let savedSession = safeParse(key, {});
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            
            let currentSets = 0;
            if (isCustomProgram) {
                currentSets = db[currentProgram].weeks[selectedWeek][selectedDay][exIndex].blocks[bIndex].sets;
            } else {
                if (!savedSession.modifiedBlocks) savedSession.modifiedBlocks = {};
                const bKey = `${exIndex}_${bIndex}`;
                currentSets = savedSession.modifiedBlocks[bKey];
                if (currentSets === undefined) {
                    const baseEx = getActiveExercises(currentProgram, selectedWeek, selectedDay, key)[exIndex];
                    currentSets = baseEx.blocks[bIndex].sets;
                }
            }

            if (currentSets <= 1) {
                alert("Cannot delete the last set. Delete the entire exercise instead.");
                renderWorkout();
                return;
            }

            // Shift data up so the specifically deleted set disappears smoothly
            for (let s = setNum; s < currentSets; s++) {
                const oldPrefix = `ex-${exIndex}_b${bIndex}_s${s+1}`;
                const newPrefix = `ex-${exIndex}_b${bIndex}_s${s}`;
                ['reps', 'rpe', 'load', 'check'].forEach(suffix => {
                    if (savedSession[`${oldPrefix}_${suffix}`] !== undefined) {
                        savedSession[`${newPrefix}_${suffix}`] = savedSession[`${oldPrefix}_${suffix}`];
                    } else {
                        delete savedSession[`${newPrefix}_${suffix}`];
                    }
                });
            }
            const lastPrefix = `ex-${exIndex}_b${bIndex}_s${currentSets}`;
            ['reps', 'rpe', 'load', 'check'].forEach(suffix => delete savedSession[`${lastPrefix}_${suffix}`]);

            if (isCustomProgram) {
                db[currentProgram].weeks[selectedWeek][selectedDay][exIndex].blocks[bIndex].sets--;
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                const bKey = `${exIndex}_${bIndex}`;
                savedSession.modifiedBlocks[bKey] = currentSets - 1;
            }
            
            localStorage.setItem(key, JSON.stringify(savedSession));
            renderWorkout();
        };

        // 1. Load the Audio Objects
        let activeAudio = new Audio('./assets/audio/ding.mp3'); 
        activeAudio.preload = 'auto';

        // THE SPOTIFY HACK: Silent audio loop to keep the browser awake in the background
        const silentURI = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        let silentKeeper = new Audio(silentURI);
        silentKeeper.loop = true; 

        // NEW: Forcefully strips audio focus from the browser so Spotify/Podcasts go back to full volume
        function releaseAudioFocus() {
            if (silentKeeper) {
                silentKeeper.pause();
                silentKeeper.src = ''; // Wipes the source completely
                silentKeeper.load();   // Forces the OS to abandon the audio session
            }
        }

        function playBeep() {
            try {
                activeAudio.currentTime = 0;
                activeAudio.play().catch(e => console.log("Audio play blocked:", e));
            } catch(e) {}
        }

        // UPGRADED START TIMER
        function startTimer(seconds) {
            const banner = document.getElementById('rest-timer-banner');
            banner.classList.remove('finished');
            
            const actionBtn = document.getElementById('timer-action-btn');
            if (actionBtn) actionBtn.innerText = "Skip";
            
            timeLeft = seconds;
            timerTargetMs = Date.now() + (seconds * 1000); 
            
            updateTimerDisplay();
            banner.classList.add('active');
            document.getElementById('home-screen').classList.add('timer-active');

            // --- TRIGGER BREATHING FAB ---
            const fab = document.querySelector('.global-timer-fab');
            if (fab && seconds > 0) fab.classList.add('timer-active');

            // --- PRIME AUDIO & START SILENT LOOP ---
            try {
                activeAudio.volume = 0;
                activeAudio.play().then(() => {
                    activeAudio.pause();
                    activeAudio.volume = 1;
                    activeAudio.currentTime = 0;
                }).catch(()=>{});
                
                // Re-inject the source and keep the app awake in the background!
                silentKeeper.src = silentURI; 
                silentKeeper.play().catch(()=>{});
            } catch (e) {}
            
            timerWorker.postMessage('stop');
            timerWorker.postMessage('start');
            
            timerWorker.onmessage = function() {
                timeLeft = Math.round((timerTargetMs - Date.now()) / 1000);
                
                // Trigger at 0, but DO NOT stop the worker so it goes negative!
                if (timeLeft <= 0 && !banner.classList.contains('finished')) {
                    playBeep(); 
                    completeTimer();
                }
                
                updateTimerDisplay();
            };
        }

        function updateTimerDisplay() {
            const absTime = Math.abs(timeLeft);
            const m = Math.floor(absTime / 60).toString().padStart(2, '0');
            const s = (absTime % 60).toString().padStart(2, '0');
            document.getElementById('timer-display').innerText = `${m}:${s}`;
        }

        function adjustTimer(seconds) {
            timerTargetMs += (seconds * 1000); 
            timeLeft = Math.round((timerTargetMs - Date.now()) / 1000);
            
            const banner = document.getElementById('rest-timer-banner');
            if (timeLeft > 0 && banner.classList.contains('finished')) {
                banner.classList.remove('finished');
                const actionBtn = document.getElementById('timer-action-btn');
                if (actionBtn) actionBtn.innerText = "Skip";
            }
            updateTimerDisplay();
        }

        function closeTimer() {
            timerWorker.postMessage('stop');
            document.getElementById('rest-timer-banner').classList.remove('active');
            document.getElementById('home-screen').classList.remove('timer-active');
            
            const fab = document.querySelector('.global-timer-fab');
            if (fab) fab.classList.remove('timer-active'); // Stop Breathing
            
            if (activeAudio) { activeAudio.pause(); activeAudio.currentTime = 0; }
            
            // Instantly restore background music volume
            releaseAudioFocus(); 

            // Clear any OS notifications
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then(function(reg) {
                    reg.getNotifications({tag: 'gomu-timer'}).then(function(notifications) {
                        notifications.forEach(n => n.close());
                    });
                });
            }
        }

        function completeTimer() {
            const banner = document.getElementById('rest-timer-banner');
            banner.classList.add('finished');
            
            const actionBtn = document.getElementById('timer-action-btn');
            if (actionBtn) actionBtn.innerText = "Dismiss";

            const fab = document.querySelector('.global-timer-fab');
            if (fab) fab.classList.remove('timer-active'); // Stop Breathing

            // Instantly restore background music volume once the rest is over
            releaseAudioFocus();

            // --- NATIVE PWA BACKGROUND NOTIFICATION ---
            if (document.hidden && "Notification" in window && Notification.permission === "granted") {
                if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.ready.then(function(reg) {
                        reg.showNotification("⏱️ Rest Complete!", {
                            body: "Time for your next set. Tap to resume.",
                            icon: "./logo.png",
                            vibrate: [200, 100, 200, 100, 400],
                            tag: "gomu-timer",
                            renotify: true,
                            requireInteraction: true // Keeps the notification on screen
                        });
                    });
                }
            }

            if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
        }

        // --- SMART CASCADE AUTO-FILL AND LOCK ---
        window.toggleCheck = function(el) {
            if (document.querySelector('.preview-mode')) return; // Safety check
            if (navigator.vibrate) navigator.vibrate(15); // Tiny physical tap!
            
        // NEW: Instantly request notification permission on their first physical tap
            if ("Notification" in window && Notification.permission === "default") {
                Notification.requestPermission().then(permission => {
                    console.log("Notification permission:", permission);
                });
            }
            el.classList.toggle('checked');
            const isChecked = el.classList.contains('checked');
            saveSessionState(el.id, isChecked);
            
            const baseId = el.id.replace('_check', '');
            const loadInput = document.getElementById(baseId + '_load');
            const rpeInput = document.getElementById(baseId + '_rpe');
            const repsInput = document.getElementById(baseId + '_reps'); // NEW: grabs editable reps
            
            if (isChecked) {
                if (loadInput) loadInput.disabled = true;
                if (rpeInput) rpeInput.disabled = true;
                if (repsInput) repsInput.disabled = true; // Locks reps

                if (loadInput && loadInput.value) {
                    const val = parseFloat(loadInput.value);
                    saveSessionState(loadInput.id, loadInput.value);
                    
                    const exName = normalizeExName(loadInput.dataset.exname);
                    let lastUsed = safeParse('lastUsedWeights', {});
                    
                    // NEW: Convert old memory to object and save strictly by Set Number
                    if (typeof lastUsed[exName] !== 'object' || lastUsed[exName] === null) {
                        lastUsed[exName] = { fallback: lastUsed[exName] };
                    }
                    const suffixMatch = loadInput.id.match(/_b\d+_s\d+(?:_extra_\d+)?/);
                    if (suffixMatch) lastUsed[exName][suffixMatch[0]] = loadInput.value;
                    
                    localStorage.setItem('lastUsedWeights', JSON.stringify(lastUsed));

                    if (!isNaN(val)) {
                        let actualBests = safeParse('actualBests', {});
                        const reps = repsInput && repsInput.value ? parseFloat(repsInput.value) : (parseFloat(loadInput.dataset.reps) || 0);
                        const rpeVal = rpeInput && rpeInput.value ? parseFloat(rpeInput.value) : 10;
                        
                        let effectiveWeight = val;
                        if (isBodyweightExercise(exName)) {
                            const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                            if (bw > 0) effectiveWeight += bw;
                        }

                        // Calculate Estimated 1RM for true strength comparison
                        const getSetE1RM = (w, r, rpe) => {
                            if (!w || w <= 0 || !r || r <= 0) return 0;
                            const rts = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };
                            let parsed = isNaN(rpe) || rpe < 0 || rpe > 10 ? 10 : rpe;
                            let rounded = Math.round(parsed * 2) / 2;
                            let rIdx = Math.max(0, Math.min(11, r - 1));
                            let pct = rounded >= 5 ? rts[rounded][rIdx] : Math.max(0.1, rts[5][rIdx] - ((5 - rounded) * 0.025));
                            return w / pct;
                        };

                        const newE1RM = getSetE1RM(effectiveWeight, reps, rpeVal);
                        let oldRecord = actualBests[exName];
                        
                        let oldEffectiveWeight = oldRecord ? oldRecord.weight : 0;
                        if (oldRecord && isBodyweightExercise(exName)) {
                            const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                            if (bw > 0) oldEffectiveWeight += bw;
                        }
                        
                        // Fallback to assuming the old record was an RPE 10 if it doesn't have an e1rm saved yet
                        let oldE1RM = oldRecord ? (oldRecord.e1rm || getSetE1RM(oldEffectiveWeight, oldRecord.reps, 10)) : 0;
                        
                        // Buffer to avoid microscopic floating point math errors
                        const isNewE1rmBetter = (newE1RM - oldE1RM) > 0.01;
                        const isSameE1rmButHeavier = Math.abs(newE1RM - oldE1RM) <= 0.01 && val > oldRecord.weight;

                        if (!oldRecord || isNewE1rmBetter || isSameE1rmButHeavier) {
                            
                            // Detect if this is a PR (only fire if beating a previously established record)
                            if (oldRecord) {
                                fireConfetti();
                                showPRToast(exName, val, reps);
                            }
                            
                            actualBests[exName] = { weight: val, reps: reps, e1rm: newE1RM, date: Date.now() };
                            localStorage.setItem('actualBests', JSON.stringify(actualBests));
                            // Append to PR timeline history
                            const prHist = safeParse('prHistory', {});
                            if (!prHist[exName]) prHist[exName] = [];
                            prHist[exName].push({ weight: val, reps: reps, e1rm: parseFloat(newE1RM.toFixed(1)), date: Date.now() });
                            if (prHist[exName].length > 30) prHist[exName] = prHist[exName].slice(-30);
                            localStorage.setItem('prHistory', JSON.stringify(prHist));
                        }
                    }
                }
                if (rpeInput && rpeInput.value) {
                    saveSessionState(rpeInput.id, rpeInput.value);
                }
                if (repsInput && repsInput.value) {
                    saveSessionState(repsInput.id, repsInput.value); // Saves actual reps
                }

                // Cascade ONLY load to next sets (keep target RPE and reps as default)
                const myoType = el.dataset.myotype;
                const currentLoad = loadInput ? loadInput.value : '';

                if (myoType && currentLoad !== '') {
                    // MYO-REP CASCADE: Push load to next sets, but STOP if we hit a new Activation block
                    const exIdMatch = baseId.match(/(ex-\d+)/);
                    const currentBlockMatch = baseId.match(/_b(\d+)_/);
                    if (exIdMatch && currentBlockMatch) {
                        const exId = exIdMatch[1];
                        const currentBIndex = parseInt(currentBlockMatch[1]);
                        const allLoadInputs = document.querySelectorAll(`input[id^="${exId}_b"][id$="_load"]`);
                        
                        let foundCurrent = false;
                        for (let input of allLoadInputs) {
                            if (input.id === (loadInput ? loadInput.id : '')) {
                                foundCurrent = true;
                            } else if (foundCurrent) {
                                const targetCheckId = input.id.replace('_load', '_check');
                                const targetCheck = document.getElementById(targetCheckId);
                                
                                // Stop cascading if we hit a NEW Activation block
                                if (targetCheck && targetCheck.dataset.myotype === 'activation' && !input.id.includes(`_b${currentBIndex}_`)) {
                                    break; 
                                }
                                
                                if (targetCheck && !targetCheck.classList.contains('checked')) {
                                    input.value = currentLoad;
                                    saveSessionState(input.id, currentLoad);
                                    input.dispatchEvent(new Event('input', {bubbles: true}));
                                }
                            }
                        }
                    }
                } else {
                    // STANDARD CASCADE: Only push load to next sets within the SAME block
                    const match = baseId.match(/(ex-\d+_b\d+)_s(\d+)/);
                    if (match) {
                        const blockPrefix = match[1];
                        let currentSet = parseInt(match[2]);

                        let nextSet = currentSet + 1;
                        while(true) {
                            const nextCheck = document.getElementById(`${blockPrefix}_s${nextSet}_check`);
                            if (!nextCheck) break; 

                            if (!nextCheck.classList.contains('checked')) {
                                const nextLoad = document.getElementById(`${blockPrefix}_s${nextSet}_load`);

                                if (nextLoad && currentLoad !== '') {
                                    nextLoad.value = currentLoad;
                                    saveSessionState(nextLoad.id, currentLoad);
                                    
                                    // This triggers the e1RM button on this future set to recalculate 
                                    // using the cascaded weight + its original untouched RPE!
                                    nextLoad.dispatchEvent(new Event('input', {bubbles: true}));
                                }
                            }
                            nextSet++;
                        }
                    }
                }

                let restSeconds = parseInt(el.dataset.rest) || 90; 

                // UPGRADED: Dynamic RPE-Based Rest Timer for ALL Lifts
                if (loadInput && rpeInput && rpeInput.value !== '') {
                    const rpeVal = parseFloat(rpeInput.value);
                    if (!isNaN(rpeVal)) {
                        if (loadInput.classList.contains('main-load')) {
                            // Main Lifts Scale (Orange)
                            if (rpeVal >= 9) restSeconds = 300;        // RPE 9-10: 5 mins
                            else if (rpeVal >= 8) restSeconds = 240;   // RPE 8-8.5: 4 mins
                            else if (rpeVal >= 7) restSeconds = 180;   // RPE 7-7.5: 3 mins
                            else if (rpeVal >= 6) restSeconds = 150;   // RPE 6-6.5: 2.5 mins
                            else if (rpeVal >= 5) restSeconds = 120;   // RPE 5-5.5: 2 mins
                            else restSeconds = 90;                     // RPE < 5: 1.5 mins
                        } else {
                            // Accessory Lifts Scale (Teal)
                            if (rpeVal >= 9) restSeconds = 180;        // RPE 9-10: 3 mins
                            else if (rpeVal >= 8) restSeconds = 150;   // RPE 8-8.5: 2.5 mins
                            else if (rpeVal >= 7) restSeconds = 120;   // RPE 7-7.5: 2 mins
                            else restSeconds = 90;                     // RPE < 7: 1.5 mins
                        }
                    }
                }

                // MYO-REP TIMER HIJACK: Only 20s if the NEXT set is a Myo Back-off
                if (myoType) {
                    const exIdMatch = baseId.match(/(ex-\d+)/);
                    if (exIdMatch) {
                        const exId = exIdMatch[1];
                        const allChecks = Array.from(document.querySelectorAll(`span[id^="${exId}_b"][id$="_check"]`));
                        const currentIndex = allChecks.findIndex(c => c.id === el.id);
                        if (currentIndex !== -1 && currentIndex + 1 < allChecks.length) {
                            const nextCheck = allChecks[currentIndex + 1];
                            // If the next set is a back-off, 20s. If it's an Activation, give them full rest!
                            if (nextCheck.dataset.myotype === 'backoff') {
                                restSeconds = 20; 
                            }
                        }
                    }
                }

                // SUPERSET TIMER HIJACK: Give 15s to switch machines if this exercise links to the next!
                if (el.dataset.superset === 'true') {
                    restSeconds = 15;
                }

                startTimer(restSeconds);
                if (rpeInput && repsInput && loadInput) {
                const weight = parseFloat(loadInput.value);
                const rpeVal = parseFloat(rpeInput.value);
                const reps = parseFloat(repsInput.value);
                
                if (!isNaN(weight) && !isNaN(rpeVal) && !isNaN(reps)) {
                    // This function will auto-generate the set and re-render the screen
                    checkAndAddTargetRpeSet(baseId, weight, rpeVal, reps); 
                }
            }
            } else {
                if (loadInput) loadInput.disabled = false;
                if (rpeInput) rpeInput.disabled = false;
                if (repsInput) repsInput.disabled = false; // Unlocks reps
            }
        };

        function saveSessionState(key, value) {
            const workoutKey = getWorkoutKey();
            let savedSession = safeParse(workoutKey, {});
            savedSession[key] = value;
            localStorage.setItem(workoutKey, JSON.stringify(savedSession));
        }

        window.dismissTargetSet = function(exIndex, bIndex, setId, extraIndex) {
            const workoutKey = getWorkoutKey();
            let savedSession = safeParse(workoutKey, {});
            const extrasKey = `extras_${exIndex}_${bIndex}_${setId}`;
            let extrasArray = savedSession[extrasKey] || [];
            if (extraIndex >= 0 && extraIndex < extrasArray.length) {
                // Remove this and all subsequent extras
                extrasArray = extrasArray.slice(0, extraIndex);
                savedSession[extrasKey] = extrasArray;
                localStorage.setItem(workoutKey, JSON.stringify(savedSession));
                renderWorkout();
            }
        };

        function checkAndAddTargetRpeSet(rowId, weight, inputRpe, reps) {
            // Match standard set (s1) or an extra set attached to it (s1_extra_0)
            const match = rowId.match(/ex-(\d+)_b(\d+)_(s\d+)(?:_extra_(\d+))?/);
            if (!match) return;

            const exIndex = parseInt(match[1]);
            const bIndex = parseInt(match[2]);
            const setIdentifier = match[3]; // e.g., 's1', 's2'
            const extraIdxStr = match[4]; // e.g., undefined, '0', '1'

            const ex = db[currentProgram].weeks[selectedWeek][selectedDay][exIndex];
            const block = ex.blocks[bIndex];

            // If the block has no target RPE, we don't calculate anything
            if (!block.targetRpe) return;
            
            // Determine the index of the extra set we are currently evaluating
            let currentExtraIndex = extraIdxStr !== undefined ? parseInt(extraIdxStr) : -1;

            const workoutKey = getWorkoutKey();
            let savedSession = safeParse(workoutKey, {});
            
            // NEW: The memory key is now permanently tied to the specific base set
            const extrasKey = `extras_${exIndex}_${bIndex}_${setIdentifier}`;
            let extrasArray = savedSession[extrasKey] || [];

            // Did we undershoot?
            if (inputRpe < block.targetRpe) {
                // Updated Coach's Custom RPE Chart (RPE 5 to 10)
                const rtsChart = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };

                // Unlocked to allow RPE down to 0
                let rInputRpe = Math.max(0, Math.min(10, Math.round(inputRpe * 2) / 2));
                let rTargetRpe = Math.max(0, Math.min(10, Math.round(block.targetRpe * 2) / 2));
                let repIndex = Math.max(0, Math.min(11, reps - 1));

                // NEW: Dynamic Extrapolator for RPE < 5 (Subtracts 2.5% per RPE point dropped)
                const getPct = (rpe, rIdx) => {
                    if (rpe >= 5) return rtsChart[rpe][rIdx];
                    return Math.max(0.1, rtsChart[5][rIdx] - ((5 - rpe) * 0.025));
                };

                const currentPct = getPct(rInputRpe, repIndex);
                const targetPct = getPct(rTargetRpe, repIndex);

                let effectiveWeight = weight;
                if (isBodyweightExercise(ex.name)) {
                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                    if (bw > 0) effectiveWeight += bw;
                }

                const e1rm = effectiveWeight / currentPct;
                let targetEffectiveWeight = roundForEquipment(e1rm * targetPct, ex.name);
                
                let newWeight = targetEffectiveWeight;
                if (isBodyweightExercise(ex.name)) {
                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                    if (bw > 0) newWeight = Math.max(0, targetEffectiveWeight - bw); // Subtract BW back out so it just tells you the added plate weight!
                }

                // Skip if rounded weight is the same as what was just lifted
                if (newWeight === weight) return;

                extrasArray = extrasArray.slice(0, currentExtraIndex + 1);
                extrasArray.push({ reps: reps, rpe: block.targetRpe, weight: newWeight });
                
                savedSession[extrasKey] = extrasArray;

                // --- NEW: Auto-update the rest of the standard sets in this block ---
                const baseSetNum = parseInt(setIdentifier.replace('s', ''));
                for (let sNum = baseSetNum + 1; sNum <= block.sets; sNum++) {
                    const upcomingCheckId = `ex-${exIndex}_b${bIndex}_s${sNum}_check`;
                    const upcomingLoadId = `ex-${exIndex}_b${bIndex}_s${sNum}_load`;
                    
                    // Only update future sets if they haven't been completed yet
                    if (!savedSession[upcomingCheckId]) {
                        savedSession[upcomingLoadId] = newWeight;
                    }
                }
                // --------------------------------------------------------------------

                localStorage.setItem(workoutKey, JSON.stringify(savedSession));
                renderWorkout();

            } else {
                // If we hit target RPE, truncate array to stop generating sets
                const newExtras = extrasArray.slice(0, currentExtraIndex + 1);
                if (newExtras.length !== extrasArray.length) {
                    savedSession[extrasKey] = newExtras;
                    localStorage.setItem(workoutKey, JSON.stringify(savedSession));
                    renderWorkout();
                }
            }
        }

        function attachListeners() {
            document.querySelectorAll('.saveable').forEach(input => {
                input.addEventListener('input', (e) => {
                    saveSessionState(e.target.id, e.target.value);
                    if(e.target.id.includes('_load') && e.target.value) {
                        let lastUsed = safeParse('lastUsedWeights', {});
                        const exName = normalizeExName(e.target.dataset.exname);
                        
                        // NEW: Save strictly by Set Number when typing
                        if (typeof lastUsed[exName] !== 'object' || lastUsed[exName] === null) {
                            lastUsed[exName] = { fallback: lastUsed[exName] };
                        }
                        const suffixMatch = e.target.id.match(/_b\d+_s\d+(?:_extra_\d+)?/);
                        if (suffixMatch) lastUsed[exName][suffixMatch[0]] = e.target.value;
                        
                        localStorage.setItem('lastUsedWeights', JSON.stringify(lastUsed));
                    }
                });
            });

            const calculateTrigger = (e) => {
                const input = e.target;
                const rowId = input.dataset.rowid;
                if (!rowId) return;
                
                const loadInput = document.getElementById(`${rowId}_load`);
                const rpeInput = document.getElementById(`${rowId}_rpe`);
                const repsInput = document.getElementById(`${rowId}_reps`); 
                const btn = document.getElementById(`e1rm-btn-${rowId}`);
                
                if(!loadInput || !rpeInput || !repsInput || !btn) return;

                const exName = normalizeExName(loadInput.dataset.exname); // BUG FIX: Defines the exercise name so the engine doesn't crash!

                const weight = parseFloat(loadInput.value) || 0; // Handles empty or 0 inputs (0kg added)
                const rpe = parseFloat(rpeInput.value);
                const reps = parseFloat(repsInput.value); 

                let effectiveWeight = weight;
                if (isBodyweightExercise(exName)) {
                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                    if (bw > 0) effectiveWeight += bw;
                }

                if (effectiveWeight > 0 && rpe >= 0 && rpe <= 10 && reps > 0) {
                    
                    const rtsChart = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };

                    let roundedRpe = Math.round(rpe * 2) / 2;
                    let repIndex = Math.max(0, Math.min(11, reps - 1));

                    // NEW: Calculate percentage with extrapolation
                    let percentage = 0;
                    if (roundedRpe >= 5) {
                        percentage = rtsChart[roundedRpe][repIndex];
                    } else {
                        percentage = Math.max(0.1, rtsChart[5][repIndex] - ((5 - roundedRpe) * 0.025));
                    }
                    
                    // FIX: Use effectiveWeight (Load + Bodyweight) so Pull-ups/Dips calculate correctly!
                    const e1rm = effectiveWeight / percentage;

                    btn.innerHTML = `<span class="e1rm-label">e1RM</span><span class="e1rm-value">${e1rm.toFixed(1)}</span>`;
                    btn.dataset.e1rm = e1rm;
                    btn.classList.add('ready');

                    // PR badge: light up if this e1rm beats the stored best
                    const _actBests = safeParse('actualBests', {});
                    const _best = _actBests[exName];
                    const _bestE1rm = _best ? (_best.e1rm || 0) : 0;
                    if (_bestE1rm > 0 && e1rm > _bestE1rm + 0.01) {
                        btn.classList.add('pr');
                    } else {
                        btn.classList.remove('pr');
                    }
                } else {
                    btn.innerHTML = `<span class="e1rm-label">Calc</span><span class="e1rm-value">--</span>`;
                    btn.dataset.e1rm = "0";
                    btn.classList.remove('ready');
                    btn.classList.remove('pr');
                }
            };

            document.querySelectorAll('.calc-trigger').forEach(input => {
                input.addEventListener('input', calculateTrigger);
                if(input.value) calculateTrigger({target: input}); 
            });

            document.querySelectorAll('.e1rm-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const currentBtn = e.currentTarget;
                    const exId = currentBtn.dataset.exid;
                    const exName = normalizeExName(currentBtn.dataset.exname);
                    const e1rm = parseFloat(currentBtn.dataset.e1rm);
                    const clickedRowId = currentBtn.dataset.rowid;
                    
                    const clickedLoadInput = document.getElementById(`${clickedRowId}_load`);
                    const clickedWeight = clickedLoadInput ? parseFloat(clickedLoadInput.value) : 0;
                    
                    if (e1rm > 0) {
                        let saved1RMs = safeParse('global1RMs', {});
                        saved1RMs[exName] = e1rm;
                        localStorage.setItem('global1RMs', JSON.stringify(saved1RMs));
                        
                        const headerE1rm = document.getElementById(`global-e1rm-${exId}`);
                        if(headerE1rm) headerE1rm.innerText = `Ref 1RM: ${e1rm.toFixed(1)}kg`;

                        const clickedBlockMatch = clickedRowId.match(/_b(\d+)_/);
                        const clickedBlockIdx = clickedBlockMatch ? clickedBlockMatch[1] : null;

                        document.querySelectorAll(`input[id$="_load"][data-exid="${exId}"]`).forEach(loadInput => {
                            const targetRowId = loadInput.dataset.rowid;
                            const checkCircle = document.getElementById(`${targetRowId}_check`);
                            
                            // FIX: Skip sets that are already checked, AND skip the exact row you just clicked
                            // so it doesn't overwrite your manual entry!
                            if (targetRowId === clickedRowId || (checkCircle && checkCircle.classList.contains('checked'))) {
                                return; 
                            }
                            
                            const targetBlockMatch = targetRowId.match(/_b(\d+)_/);
                            const targetBlockIdx = targetBlockMatch ? targetBlockMatch[1] : null;
                            const pct = parseFloat(loadInput.dataset.pct);
                            
                            const targetRepsInput = document.getElementById(`${targetRowId}_reps`);
                            const targetRpeInput = document.getElementById(`${targetRowId}_rpe`);
                            
                            let targetPct = pct || 0; // Fallback to programmed percent
                            
                            // Prioritize true Auto-Regulation (RPE) over rigid percentage
                            if (targetRepsInput && targetRpeInput && targetRpeInput.value) {
                                const trReps = parseFloat(targetRepsInput.value);
                                const trRpe = parseFloat(targetRpeInput.value);
                                
                                if (trReps > 0 && trRpe >= 0 && trRpe <= 10) {
                                    const rtsChart = {
                                10:   [1.000, 0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.690],
                                9.5:  [0.980, 0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670],
                                9:    [0.960, 0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650],
                                8.5:  [0.940, 0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640],
                                8:    [0.920, 0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630],
                                7.5:  [0.910, 0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610],
                                7:    [0.890, 0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600],
                                6.5:  [0.880, 0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580],
                                6:    [0.860, 0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570],
                                5.5:  [0.850, 0.820, 0.800, 0.770, 0.750, 0.720, 0.690, 0.670, 0.640, 0.610, 0.580, 0.550],
                                5:    [0.840, 0.810, 0.790, 0.760, 0.740, 0.710, 0.680, 0.650, 0.630, 0.600, 0.570, 0.540]
                            };
                                    let rRoundedRpe = Math.round(trRpe * 2) / 2;
                                    let rRepIndex = Math.max(0, Math.min(11, trReps - 1));
                                    
                                    if (rRoundedRpe >= 5) {
                                        targetPct = rtsChart[rRoundedRpe][rRepIndex];
                                    } else {
                                        targetPct = Math.max(0.1, rtsChart[5][rRepIndex] - ((5 - rRoundedRpe) * 0.025));
                                    }
                                }
                            }

                            // Calculate weight based on percentage
                            if (targetPct > 0) {
                                let targetWeight = roundForEquipment(e1rm * targetPct, exName);
                                
                                if (isBodyweightExercise(exName)) {
                                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                                    if (bw > 0) targetWeight = Math.max(0, targetWeight - bw);
                                }
                                
                                loadInput.value = targetWeight;
                                saveSessionState(loadInput.id, targetWeight); 
                                loadInput.dispatchEvent(new Event('input', {bubbles: true}));
                                
                            // ONLY cascade the raw weight if it's a straight-volume block (no pct, no RPE)
                            } else if (clickedBlockIdx !== null && clickedBlockIdx === targetBlockIdx) {
                                if (clickedWeight > 0) {
                                    loadInput.value = clickedWeight;
                                    saveSessionState(loadInput.id, clickedWeight);
                                    loadInput.dispatchEvent(new Event('input', {bubbles: true})); 
                                }
                            }
                        });
                        
                        updateDashboard(); 
                    }
                });
            });
        }

        function renderStreak() {
            const container = document.getElementById('streak-container');
            if(!container) return;
            let history = safeParse('workoutHistory', []);
            let workoutDates = history.map(h => {
                let d = new Date(h.date); d.setHours(0,0,0,0); return d.getTime();
            });
            
            // Get today in your local timezone
            let today = new Date();
            today.setHours(0,0,0,0);
            
            // Find the most recent Saturday (0=Sun, ..., 6=Sat)
            let dayOfWeek = today.getDay(); 
            let daysSinceSaturday = (dayOfWeek === 6) ? 0 : (dayOfWeek + 1);
            
            let startOfStreak = new Date(today);
            startOfStreak.setDate(today.getDate() - daysSinceSaturday);

            let html = '';
            // Hard-locked to your Saturday-Friday schedule
            const dayLabels = ['S', 'S', 'M', 'T', 'W', 'T', 'F'];
            
            for (let i = 0; i < 7; i++) {
                let d = new Date(startOfStreak);
                d.setDate(startOfStreak.getDate() + i);
                
                let isDone = workoutDates.includes(d.getTime());
                let isToday = d.getTime() === today.getTime();
                let content = isDone ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : dayLabels[i];
                
                // Dim future days so you know the week isn't over yet
                if (d.getTime() > today.getTime()) {
                    html += `<div class="streak-day"><div class="s-dot" style="opacity: 0.3;">${dayLabels[i]}</div></div>`;
                } else {
                    let cls = isDone ? 's-dot active' : (isToday ? 's-dot today' : 's-dot');
                    html += `<div class="streak-day"><div class="${cls}">${content}</div></div>`;
                }
            }
            container.innerHTML = html;
        }

        function updateAnalytics() {
            renderStreak();
            let history = safeParse('workoutHistory', []);
            let ltWorkouts = history.length;
            let ltSets = 0;
            let ltVol = 0;
            history.forEach(log => { ltSets += (log.sets || 0); ltVol += (log.volume || 0); });
            const formatVol = (v) => {
                if (v >= 1000000) return (v/1000000).toFixed(1) + 'm kg';
                if (v >= 1000) return (v/1000).toFixed(1) + 'k kg';
                return Math.round(v) + ' kg';
            };
            const wEl = document.getElementById('lt-workouts');
            const sEl = document.getElementById('lt-sets');
            const vEl = document.getElementById('lt-vol');
            if(wEl) wEl.innerText = ltWorkouts;
            if(sEl) sEl.innerText = ltSets;
            if(vEl) vEl.innerText = formatVol(ltVol);
        }

        async function cancelActiveWorkout() {
            const confirmed = await showConfirm(
                "Stop Workout?",
                "Are you sure you want to cancel this active session? Your entered data will be cleared, and any PRs hit today will be reverted.",
                "Stop Workout",
                "Keep Lifting",
                true
            );
            if (confirmed) {
                // REVERT ENGINE: Restore the snapshot from before the workout started
                if (activeWorkout && activeWorkout.backupState) {
                    localStorage.setItem('actualBests', JSON.stringify(activeWorkout.backupState.actualBests));
                    localStorage.setItem('global1RMs', JSON.stringify(activeWorkout.backupState.global1RMs));
                    localStorage.setItem('lastUsedWeights', JSON.stringify(activeWorkout.backupState.lastUsedWeights));
                }

                const key = getWorkoutKey();
                localStorage.removeItem(key); // Clear the session state
                activeWorkout = null;
                localStorage.removeItem('activeWorkout');
                renderDayPills();
                renderWorkout();
                updateBanners();
                closeTimer();
                updateDashboard();
            }
        }
        // --- CUSTOM WORKOUT LOGIC ---

        const originalInitApp = initApp;
        initApp = async function() {
            // 1. Get custom workouts from browser memory
            const customProgs = safeParse('customPrograms', {});

            // Seed built-in templates into custom workouts on first load
            if (!customProgs['Custom_caroline_girvan_fb']) {
                customProgs['Custom_caroline_girvan_fb'] = {
                    name: "Caroline Girvan Full Body",
                    weeks: { 1: { 1: [
                        { name: "Dumbbell High Squat", type: "accessory", notes: "30s work / 30s rest. Deep squat with dumbbells at shoulders. Controlled tempo, full range of motion.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Sumo Deadlift Squat", type: "accessory", notes: "30s work / 30s rest. Wide stance, toes out, dumbbell between legs. Squat down and drive through heels.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Static Lunge", type: "accessory", notes: "30s work / 30s rest. Switch leg every set. Stay in split stance and pulse up and down.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Romanian Deadlift", type: "accessory", notes: "30s work / 30s rest. Shoulder blades together, knees slightly bent, push hips back.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Shoulder Press", type: "accessory", notes: "30s work / 30s rest. Can use 1 or 2 dumbbells. Full lockout overhead.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Bent Over Row", type: "accessory", notes: "30s work / 30s rest. Switch arm every set. Let muscles lengthen at bottom, draw elbow up slowly.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Chest Press", type: "accessory", notes: "30s work / 30s rest. Lying on floor or bench. Controlled lower, press up.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Dumbbell Pullover", type: "accessory", notes: "30s work / 30s rest. Lying on bench or floor. Slight bend in elbows, stretch lats at bottom.", blocks: [{ type: "work", sets: 3, reps: 10, targetRpe: 8 }] },
                        { name: "Plank", type: "accessory", notes: "Hold for 2 minutes total. Break into sets if needed.", blocks: [{ type: "work", sets: 1, reps: 1, targetRpe: 10 }] }
                    ] } }
                };
                localStorage.setItem('customPrograms', JSON.stringify(customProgs));
            }

            // 2. SAFETY CHECK: If db (from database.js) doesn't exist, create it
            if (typeof window.db === 'undefined') window.db = {};

            // 3. Merge custom workouts INTO the main database object
            Object.keys(customProgs).forEach(k => {
                window.db[k] = customProgs[k];
            });

            // 4. Run the original boot sequence
            await originalInitApp();
        };

        const originalToggleWorkoutState = toggleWorkoutState;
        toggleWorkoutState = async function(action) {
            const customProgs = safeParse('customPrograms', {});
            const isCustom = !!customProgs[currentProgram];

            // Only prompt for a name if it's a custom workout and hasn't been named yet!
            if (action === 'finish' && isCustom && db[currentProgram].name === "On-the-Fly Workout") {
                const keyForSummary = getWorkoutKey(); 
                const durationMs = activeWorkout && activeWorkout.startTime ? (Date.now() - activeWorkout.startTime) : 0;
                
                document.getElementById('save-custom-modal').style.display = 'flex';
                window.pendingFinishData = { key: keyForSummary, duration: durationMs };
                return; // Pauses the finish process
            }
            return await originalToggleWorkoutState(action);
        };

        function executeFinish(key, durationMs) {
            completedDays[key] = true;
            localStorage.setItem('completedDays', JSON.stringify(completedDays));
            activeWorkout = null;
            localStorage.removeItem('activeWorkout');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            closeTimer();
            if (typeof workoutDurationInterval !== 'undefined') clearInterval(workoutDurationInterval);
            const timerEl = document.getElementById('workout-duration');
            if (timerEl) timerEl.style.display = 'none';
            generateSummary(key, durationMs); 
            updateDashboard();
        }

        window.startCustomWorkout = async function() {
            const customId = 'Custom_' + Date.now();
            db[customId] = {
                name: "On-the-Fly Workout",
                weeks: { 1: { 1: [] } } 
            };
            
            let customProgs = safeParse('customPrograms', {});
            customProgs[customId] = db[customId];
            localStorage.setItem('customPrograms', JSON.stringify(customProgs));
            
            currentProgram = customId;
            selectedWeek = '1';
            selectedDay = '1';
            
            // Note: We intentionally DO NOT set `activeWorkout` here so it acts purely as a preview 
            // until you actually click "Start Workout"!
            
            updateLibraryUI();
            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
            document.getElementById('workout-screen').classList.add('active');
            renderWeekPills();
            renderDayPills();
            renderWorkout();
            updateBanners();
        };

        window.submitNewExercise = function() {
            const name = document.getElementById('add-ex-name').value.trim() || "New Exercise";
            const sets = parseInt(document.getElementById('add-ex-sets').value) || 3;
            const reps = parseInt(document.getElementById('add-ex-reps').value) || 10;
            const rpeVal = parseFloat(document.getElementById('add-ex-rpe').value);
            const isMain = name.toLowerCase().includes('squat') || name.toLowerCase().includes('bench') || name.toLowerCase().includes('deadlift');
            const newBlock = { type: 'work', sets: sets, reps: reps, targetRpe: isNaN(rpeVal) ? null : rpeVal };
            
            const isCustomProgram = currentProgram && currentProgram.startsWith('Custom_');
            
            if (isCustomProgram) {
                // Permanently edit the custom template
                const dayExercises = db[currentProgram].weeks[selectedWeek][selectedDay];
                if (dayExercises.length > 0 && dayExercises[dayExercises.length - 1].name.toLowerCase() === name.toLowerCase()) {
                    dayExercises[dayExercises.length - 1].blocks.push(newBlock);
                } else {
                    dayExercises.push({ name: name, type: isMain ? 'main' : 'accessory', blocks: [newBlock] });
                }
                const customProgs = safeParse('customPrograms', {});
                if (customProgs[currentProgram]) {
                    customProgs[currentProgram] = db[currentProgram];
                    localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                }
            } else {
                // On-the-fly edit for rigid database programs (Saved to session memory only)
                const key = getWorkoutKey();
                let savedSession = safeParse(key, {});
                if (!savedSession.addedExercises) savedSession.addedExercises = [];
                
                const lastAdded = savedSession.addedExercises[savedSession.addedExercises.length - 1];
                if (lastAdded && !lastAdded.isDeleted && lastAdded.name.toLowerCase() === name.toLowerCase()) {
                    lastAdded.blocks.push(newBlock);
                } else {
                    savedSession.addedExercises.push({ name: name, type: isMain ? 'main' : 'accessory', blocks: [newBlock] });
                }
                localStorage.setItem(key, JSON.stringify(savedSession));
            }
            
            document.getElementById('add-exercise-modal').style.display = 'none';
            document.getElementById('add-ex-name').value = '';
            document.getElementById('add-ex-rpe').value = '';
            renderWorkout();
        };

        window.deleteCustomProgram = async function(pid) {
            const confirmed = await showConfirm(
                "Delete Custom Template?",
                "Are you sure you want to delete this custom workout? Your logged history will remain safe.",
                "Delete",
                "Cancel",
                true
            );
            if (confirmed) {
                let customProgs = safeParse('customPrograms', {});
                delete customProgs[pid];
                localStorage.setItem('customPrograms', JSON.stringify(customProgs));
                delete db[pid];
                
                // NEW: Safely cancel any active session tied to this deleted template
                if (activeWorkout && activeWorkout.program === pid) {
                    activeWorkout = null;
                    localStorage.removeItem('activeWorkout');
                    updateBanners();
                }
                
                if (currentProgram === pid) {
                    currentProgram = null;
                    // BUG FIX: Removed the line that was deleting your main activeProgram!
                    document.getElementById('library-screen').classList.add('active');
                    document.getElementById('workout-screen').classList.remove('active');
                }
                
                updateLibraryUI();
                updateDashboard(); // Refreshes the dashboard to keep it perfectly synced
            }
        };

        window.confirmSaveCustom = function() {
            const name = document.getElementById('save-custom-name').value.trim() || "My Custom Workout";
            db[currentProgram].name = name;
            
            let customProgs = safeParse('customPrograms', {});
            customProgs[currentProgram] = db[currentProgram];
            localStorage.setItem('customPrograms', JSON.stringify(customProgs));
            
            document.getElementById('save-custom-modal').style.display = 'none';
            updateLibraryUI();
            
            if (window.pendingFinishData) {
                executeFinish(window.pendingFinishData.key, window.pendingFinishData.duration);
                window.pendingFinishData = null;
            }
        };

        window.skipSaveCustom = function() {
            document.getElementById('save-custom-modal').style.display = 'none';
            if (window.pendingFinishData) {
                executeFinish(window.pendingFinishData.key, window.pendingFinishData.duration);
                window.pendingFinishData = null;
            }
        };
        window.restartCustomWorkout = async function() {
            const confirmed = await showConfirm(
                "Run Template Again?",
                "This will clear the checkmarks from your last session so you can run this workout fresh today. (Your past history logs are safe!)",
                "Start Fresh",
                "Cancel",
                false
            );
            
            if (confirmed) {
                const key = getWorkoutKey();
                
                // Clear old checkmarks and session data so the boxes unlock
                localStorage.removeItem(key); 
                delete completedDays[key];
                localStorage.setItem('completedDays', JSON.stringify(completedDays));
                
                // Fire up the timer and start the workout immediately!
                toggleWorkoutState('start');
            }
        };

        window.fireConfetti = function() {
            const colors = ['#f97316', '#14b8a6', '#fff'];
            for(let i=0; i<40; i++) {
                let conf = document.createElement('div');
                conf.style.position = 'fixed';
                conf.style.width = '8px'; conf.style.height = '8px';
                conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
                conf.style.left = '50%'; conf.style.top = '50%';
                conf.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
                conf.style.zIndex = '9999'; conf.style.pointerEvents = 'none';
                document.body.appendChild(conf);

                const angle = Math.random() * Math.PI * 2;
                const velocity = 50 + Math.random() * 200;
                const tx = Math.cos(angle) * velocity;
                const ty = Math.sin(angle) * velocity - 100;

                conf.animate([
                    { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
                    { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0) rotate(${Math.random()*720}deg)`, opacity: 0 }
                ], { duration: 800 + Math.random()*500, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' }).onfinish = () => conf.remove();
            }
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]); // Victory rumble
        };

        // --- THE RPE HUB WINDOW (MODAL) ENGINE ---

        // 1. Decision-tree flow: answer Yes to exit at that RPE, No to continue down
        const rpeFlowSteps = [
            { q: "Was this too easy to count as a true work set?",   rpe: "5.5" },
            { q: "Was this fairly easy like a warm-up weight?",       rpe: "6"   },
            { q: "Was this a borderline warm-up weight?",             rpe: "6.5" },
            { q: "Was the speed fairly quick like an easy opener?",   rpe: "7"   },
            { q: "Could you have <b>MAYBE</b> done 3 more reps?",     rpe: "7.5" },
            { q: "Could you have <b>DEFINITELY</b> done 2 more reps?",rpe: "8"   },
            { q: "Could you have <b>MAYBE</b> done 2 more reps?",     rpe: "8.5" },
            { q: "Could you have <b>DEFINITELY</b> done 1 more rep?", rpe: "9"   },
            { q: "Could you have <b>MAYBE</b> done 1 more rep?",      rpe: "9.5" },
        ];

        // 2. Function to generate and open the Hub
        window.openRpeHub = function() {
            const scroller = document.getElementById('rpe-modal-scroller');

            let html = '<div class="rpe-flow">';
            rpeFlowSteps.forEach((step, i) => {
                const rpeNum = parseFloat(step.rpe);
                const badgeColor = rpeNum <= 7 ? 'var(--teal)' : rpeNum <= 8.5 ? 'var(--accent)' : 'var(--danger)';
                html += `
                <div class="rpe-flow-row">
                    <span class="rpe-flow-q">${step.q}</span>
                    <span class="rpe-flow-yes">Yes <span class="rpe-flow-badge" style="background:${badgeColor}">@${step.rpe}</span></span>
                </div>`;
                if (i < rpeFlowSteps.length - 1) {
                    html += `<div class="rpe-flow-no">No ↓</div>`;
                }
            });
            html += `
                <div class="rpe-flow-no">No ↓</div>
                <div class="rpe-flow-final"><span class="rpe-flow-badge" style="background:var(--danger)">@10</span> Maximal effort — nothing left in the tank</div>
            </div>`;

            scroller.innerHTML = html;
            document.getElementById('rpe-modal').style.display = 'flex';
        };

        // 3. Simple Close Function
        window.closeRpeModal = function() {
            document.getElementById('rpe-modal').style.display = 'none';
        };

        // --- HOME SCREEN: PROGRAM OVERVIEW MODAL ---
        
        // 1. New Accordion Function to toggle exercise lists
        window.toggleOverviewDay = function(prog, w, d) {
            const detailsDiv = document.getElementById(`overview-w${w}-details`);
            if (!detailsDiv) return;
            
            const currentShowing = detailsDiv.dataset.showingDay;
            const weekCard = detailsDiv.parentElement;
            
            // Remove highlight from all pills in this week
            weekCard.querySelectorAll('.overview-day-pill').forEach(p => {
                p.style.boxShadow = 'none';
                p.style.transform = 'scale(1)';
            });

            if (currentShowing === d) {
                // Close if clicking the same day
                detailsDiv.style.display = 'none';
                detailsDiv.dataset.showingDay = '';
            } else {
                // Open and populate
                const exercises = db[prog]?.weeks[w]?.[d] || [];
                
                let exHtml = '';
                
                if (exercises.length === 0) {
                    exHtml += `<div style="color: var(--text-muted); font-size: 12px; font-style: italic; text-align: center; padding: 10px 0;">Rest Day / No Exercises</div>`;
                } else {
                    exHtml += `<div style="display: flex; flex-direction: column; gap: 8px;">`;
                    exercises.forEach((ex, idx) => {
                        // Keep the color logic, but move it to a left-border stripe and the number
                        const isMain = ex.type ? ex.type === 'main' : (ex.name.toLowerCase() === 'squat' || ex.name.toLowerCase() === 'bench press' || ex.name.toLowerCase() === 'deadlift');
                        const stripeColor = isMain ? 'var(--accent)' : 'var(--teal)';

                        exHtml += `
                        <div style="display: flex; align-items: center; gap: 12px; background: rgba(255,255,255,0.03); padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.02); border-left: 3px solid ${stripeColor};">
                            <div style="width: 22px; height: 22px; border-radius: 6px; background: rgba(255,255,255,0.05); color: ${stripeColor}; font-size: 11px; font-weight: 900; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">${idx + 1}</div>
                            <span style="flex: 1; min-width: 0; font-weight: 700; font-size: 13px; color: #e4e4e7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${ex.name}</span>
                        </div>`;
                    });
                    exHtml += `</div>`;
                }

                detailsDiv.innerHTML = exHtml;
                detailsDiv.style.display = 'block';
                detailsDiv.dataset.showingDay = d;

                // Add a bold "pop" highlight to the active pill
                const activePill = document.getElementById(`overview-pill-${w}-${d}`);
                if (activePill) {
                    activePill.style.boxShadow = '0 0 0 2px var(--input-bg), 0 0 0 4px var(--accent)';
                    activePill.style.transform = 'scale(1.05)';
                }
            }
        };

        // 2. The Upgraded UI Generator
        window.openProgramOverview = function() {
            let mainProgram = localStorage.getItem('activeProgram');
            if (activeWorkout && activeWorkout.program) mainProgram = activeWorkout.program;
            if (!mainProgram || !db[mainProgram]) return;

            let totalDays = 0;
            let doneDays = 0;
            let nextW = null, nextD = null;
            
            // Inject inline CSS to murder the scrollbar across all browsers
            let gridHtml = '<style>#overview-scroller::-webkit-scrollbar { display: none; }</style>';
            gridHtml += '<div id="overview-scroller" style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px; margin-bottom: 20px; max-height: 300px; overflow-y: auto; padding-right: 2px; scrollbar-width: none; -ms-overflow-style: none;">';

            const weeks = Object.keys(db[mainProgram].weeks).sort((a,b) => a - b);
            for (let w of weeks) {
                // Wrap each week in a subtle card
                gridHtml += `<div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">`;
                gridHtml += `<div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 800; margin-bottom: 8px; letter-spacing: 0.5px;">Week ${w}</div>`;
                gridHtml += `<div style="display: flex; gap: 8px; flex-wrap: wrap;">`;
                
                const days = Object.keys(db[mainProgram].weeks[w]).sort((a,b) => a - b);
                for (let d of days) {
                    totalDays++;
                    const isDone = completedDays[`${mainProgram}_w${w}_d${d}`];
                    
                    let bg = isDone ? 'var(--accent)' : 'rgba(255,255,255,0.05)';
                    let color = isDone ? '#000' : 'var(--text-muted)';
                    let border = isDone ? '1px solid var(--accent)' : '1px solid var(--border)';
                    
                    if (isDone) {
                        doneDays++;
                    } else if (!nextW) {
                        nextW = w; 
                        nextD = d;
                        bg = 'transparent';
                        color = 'var(--accent)';
                        border = '1px dashed var(--accent)';
                    }
                    
                    // Bind the Accordion click event to the pill
                    gridHtml += `<div id="overview-pill-${w}-${d}" class="overview-day-pill" onclick="toggleOverviewDay('${mainProgram}', '${w}', '${d}')" style="width: 34px; height: 34px; border-radius: 6px; background: ${bg}; border: ${border}; color: ${color}; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; cursor: pointer; transition: 0.2s;">D${d}</div>`;
                }
                gridHtml += `</div>`;
                
                // The hidden Accordion dropdown container for this week
                gridHtml += `<div id="overview-w${w}-details" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.1);"></div>`;
                
                gridHtml += `</div>`; // End Week Card
            }
            gridHtml += `</div>`;

            const pct = totalDays > 0 ? Math.round((doneDays / totalDays) * 100) : 0;

            let modal = document.getElementById('program-overview-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'program-overview-modal';
                modal.style.display = 'none';
                modal.style.position = 'fixed';
                modal.style.top = '0';
                modal.style.left = '0';
                modal.style.width = '100%';
                modal.style.height = '100%';
                modal.style.background = 'rgba(0, 0, 0, 0.9)';
                modal.style.zIndex = '2500';
                modal.style.justifyContent = 'center';
                modal.style.alignItems = 'center';
                modal.style.backdropFilter = 'blur(3px)';
                document.body.appendChild(modal);
                
                modal.onclick = (e) => {
                    if(e.target === modal) modal.style.display = 'none';
                };
            }

            modal.innerHTML = `
                <div style="background: var(--input-bg); border: 2px solid var(--border); border-radius: 12px; width: 90%; max-width: 380px; padding: 24px; color: var(--text-main); display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.5);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h2 style="margin: 0; font-size: 20px; font-weight: 900; color: #fff;">${db[mainProgram].name}</h2>
                        <div style="color: var(--accent); font-size: 18px; font-weight: 900;">${pct}%</div>
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 8px;">
                        <div style="color: var(--text-muted);">Progress</div>
                        <div style="font-weight: 800; color: #fff;">${doneDays} / ${totalDays} Workouts</div>
                    </div>
                    
                    <div style="width: 100%; height: 8px; background: rgba(0,0,0,0.5); border-radius: 4px; overflow: hidden;">
                        <div style="width: ${pct}%; height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.5s ease-out;"></div>
                    </div>

                    ${gridHtml}

                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 5px; padding-top: 15px; border-top: 1px dashed rgba(255,255,255,0.1);">
                        <div>
                            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Up Next</div>
                            <div style="font-size: 16px; font-weight: 900; color: var(--accent); margin-top: 2px;">W${nextW || '-'} D${nextD || '-'}</div>
                        </div>
                        <button class="action-btn" style="background: rgba(255,255,255,0.05); color: var(--text-main); border: 1px solid var(--border); margin: 0; padding: 10px 20px; font-size: 14px; width: auto;" onclick="document.getElementById('program-overview-modal').style.display='none'">Close</button>
                    </div>
                </div>
            `;
            
            modal.style.display = 'flex';
        };

        // ── Standard Warm-Up Routine (editable, persisted) ──────────────────
        const DEFAULT_WARMUP = [
            "Calf Raises",
            "Dead Bugs, Side Planks, Bird-Dog",
            "90/90 Stretch + Rotation / Pec Stretch",
            "Plank and Push-Ups",
            "KB Single-Leg DLs",
            "KB Single-Arm Rows",
            "Elevated Reverse Lunges",
            "Band Dislocates",
            "Band Y's & Pull-aparts"
        ];

        let warmupEditMode = false;

        function getWarmupItems() {
            return safeParse('warmupRoutine', DEFAULT_WARMUP);
        }

        function saveWarmupItems(items) {
            localStorage.setItem('warmupRoutine', JSON.stringify(items));
        }

        window.renderWarmupList = function() {
            const container = document.getElementById('warmup-list');
            if (!container) return;
            const items = getWarmupItems();

            if (!warmupEditMode) {
                container.innerHTML = `
                    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
                        <button onclick="window.toggleWarmupEdit()" style="background:none;border:1px solid rgba(255,255,255,0.12);color:var(--text-muted);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit
                        </button>
                    </div>
                    ${items.map((item, i) => `
                        <div class="warmup-item">
                            <span class="warmup-num">${i + 1}</span>
                            <span class="warmup-item-text">${item}</span>
                        </div>
                    `).join('')}
                `;
            } else {
                container.innerHTML = `
                    <div style="margin-bottom:12px;">
                        ${items.map((item, i) => `
                            <div class="warmup-edit-row">
                                <input class="warmup-edit-input" value="${item.replace(/"/g, '&quot;')}"
                                    onchange="window.updateWarmupItem(${i}, this.value)" />
                                <button class="warmup-del-btn" onclick="window.deleteWarmupItem(${i})">×</button>
                            </div>
                        `).join('')}
                    </div>
                    <button onclick="window.addWarmupItem()" style="width:100%;padding:10px;background:rgba(255,255,255,0.04);border:1px dashed rgba(255,255,255,0.15);border-radius:8px;color:var(--text-muted);font-size:13px;font-weight:700;cursor:pointer;margin-bottom:12px;">+ Add Exercise</button>
                    <button onclick="window.toggleWarmupEdit()" style="width:100%;padding:10px;background:var(--accent);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;">Done</button>
                `;
            }
        };

        window.toggleWarmupEdit = function() {
            if (warmupEditMode) {
                // Flush all input values before leaving edit mode
                const inputs = document.querySelectorAll('#warmup-list .warmup-edit-input');
                const items = getWarmupItems();
                inputs.forEach((inp, i) => { if (items[i] !== undefined) items[i] = inp.value; });
                saveWarmupItems(items);
            }
            warmupEditMode = !warmupEditMode;
            renderWarmupList();
        };

        window.updateWarmupItem = function(index, value) {
            const items = getWarmupItems();
            items[index] = value;
            saveWarmupItems(items);
        };

        window.deleteWarmupItem = function(index) {
            const items = getWarmupItems();
            items.splice(index, 1);
            saveWarmupItems(items);
            renderWarmupList();
        };

        window.addWarmupItem = function() {
            const items = getWarmupItems();
            // Flush current inputs first
            const inputs = document.querySelectorAll('#warmup-list .warmup-edit-input');
            inputs.forEach((inp, i) => { if (items[i] !== undefined) items[i] = inp.value; });
            items.push('');
            saveWarmupItems(items);
            renderWarmupList();
            // Focus the new input
            const allInputs = document.querySelectorAll('#warmup-list .warmup-edit-input');
            if (allInputs.length) allInputs[allInputs.length - 1].focus();
        };

        renderWarmupList();

        // ── Unit helpers ─────────────────────────────────────────────────────
        function getUnit()  { return localStorage.getItem('preferredUnit') || 'kg'; }
        function unitSuffix() { return getUnit(); }
        function kgDisp(kg, dec = 1) {
            if (kg === null || kg === undefined || isNaN(kg)) return '--';
            const v = getUnit() === 'lbs' ? kg * 2.2046 : kg;
            return dec === 0 ? Math.round(v) : parseFloat(v.toFixed(dec));
        }
        window.toggleUnit = function() {
            localStorage.setItem('preferredUnit', getUnit() === 'kg' ? 'lbs' : 'kg');
            renderStats();
            renderHistory();
        };
        function dotsLevel(score) {
            if (score >= 500) return { label: 'World Class', color: '#f97316' };
            if (score >= 400) return { label: 'Elite',       color: '#eab308' };
            if (score >= 300) return { label: 'Advanced',    color: '#a78bfa' };
            if (score >= 200) return { label: 'Intermediate',color: '#60a5fa' };
            if (score >    0) return { label: 'Beginner',    color: '#71717a' };
            return { label: 'Unranked', color: '#3f3f46' };
        }
        function fmtDuration(ms) {
            if (!ms || ms <= 0) return null;
            const m = Math.floor(ms / 60000);
            const h = Math.floor(m / 60);
            return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
        }
        function fmtShortDate(ts) {
            if (!ts) return '';
            return new Date(ts).toLocaleDateString('default', { month: 'short', day: 'numeric', year: '2-digit' });
        }

        // ── PR Timeline toggle ────────────────────────────────────────────────
        function renderPRTimelineEl(exName, el) {
            const prHist = safeParse('prHistory', {});
            const entries = (prHist[exName] || []).slice().reverse();
            if (entries.length === 0) {
                el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">No PR progression recorded yet.</div>';
            } else {
                const safeExJS = exName.replace(/'/g, "\\'");
                el.innerHTML = entries.map(e => `
                    <div class="pr-tl-entry">
                        <span class="pr-tl-val">${kgDisp(e.weight)} ${unitSuffix()} × ${e.reps} <span style="color:var(--text-muted);font-size:11px;">(${kgDisp(e.e1rm)} e1RM)</span></span>
                        <span style="display:flex;align-items:center;gap:10px;">
                            <span class="pr-tl-date">${fmtShortDate(e.date)}</span>
                            <button onclick="event.stopPropagation();window.deletePREntry('${safeExJS}',${e.date})" style="background:none;border:none;color:var(--text-muted);font-size:16px;line-height:1;cursor:pointer;padding:0;opacity:0.5;" title="Delete this PR">×</button>
                        </span>
                    </div>`).join('');
            }
        }

        window.togglePRTimeline = function(exName) {
            const id = 'prtl-' + encodeURIComponent(exName);
            const el = document.getElementById(id);
            if (!el) return;
            const isHidden = el.style.display === 'none';
            el.style.display = isHidden ? 'block' : 'none';
            if (isHidden) renderPRTimelineEl(exName, el);
        };

        window.deletePREntry = function(exName, entryDate) {
            const prHist = safeParse('prHistory', {});
            if (!prHist[exName]) return;

            // Remove the specific entry
            prHist[exName] = prHist[exName].filter(e => e.date !== entryDate);
            localStorage.setItem('prHistory', JSON.stringify(prHist));

            // Check if this was the current best and update actualBests
            let actualBests = safeParse('actualBests', {});
            const cur = actualBests[exName];
            if (cur && cur.date === entryDate) {
                const remaining = prHist[exName];
                if (remaining.length === 0) {
                    delete actualBests[exName];
                } else {
                    const newBest = remaining.reduce((best, e) => e.e1rm > best.e1rm ? e : best, remaining[0]);
                    actualBests[exName] = { weight: newBest.weight, reps: newBest.reps, e1rm: newBest.e1rm, date: newBest.date };
                }
                localStorage.setItem('actualBests', JSON.stringify(actualBests));
                renderStats(); // Full re-render since the header card changed
            } else {
                // Just update the timeline in-place
                const id = 'prtl-' + encodeURIComponent(exName);
                const el = document.getElementById(id);
                if (el) renderPRTimelineEl(exName, el);
            }
        };

        // Confetti burst for workout complete
        window.fireConfetti = function() {
            const card = document.querySelector('.summary-card');
            if (!card) return;
            // Remove any old pieces
            card.querySelectorAll('.confetti-piece').forEach(el => el.remove());
            const colors = ['#f97316','#fb923c','#fbbf24','#14b8a6','#ffffff','#ef4444'];
            const count = 22;
            for (let i = 0; i < count; i++) {
                const el = document.createElement('div');
                el.className = 'confetti-piece';
                el.style.cssText = `
                    left: ${8 + Math.random() * 84}%;
                    background: ${colors[i % colors.length]};
                    width: ${6 + Math.random() * 6}px;
                    height: ${6 + Math.random() * 6}px;
                    border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
                    animation-delay: ${(Math.random() * 0.6).toFixed(2)}s;
                    animation-duration: ${(1.8 + Math.random() * 1).toFixed(2)}s;
                `;
                card.appendChild(el);
            }
        };

        // Boot: try sessionStorage key first (page reload), else show login
        const cachedKey = sessionStorage.getItem('gomu_key');
        if (cachedKey) {
            bootWithPassword(cachedKey, true);
        }
        // If no cached key, login screen is already visible — user enters password → checkLogin()