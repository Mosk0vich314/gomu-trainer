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
        const APP_VERSION = "v2026.03.14.1135";
        // --- HONESTY DOOR LOGIC ---
        const COACH_PASSWORD = "cristoimbecille"; // CHANGE THIS TO WHATEVER YOU WANT!

        // Immediately check if they've logged in before
        const isAuth = localStorage.getItem('gomu_auth_passed');
        if (isAuth === 'true') {
            document.getElementById('login-screen').style.display = 'none';
        }

        window.checkLogin = function() {
            const input = document.getElementById('login-password').value;
            const errorText = document.getElementById('login-error');
            const card = document.getElementById('login-card');
            
            if (input === COACH_PASSWORD) {
                // Success! Remember them and smoothly fade out the wall
                localStorage.setItem('gomu_auth_passed', 'true');
                
                const loginScreen = document.getElementById('login-screen');
                loginScreen.style.transition = 'opacity 0.4s ease';
                loginScreen.style.opacity = '0';
                
                setTimeout(() => {
                    loginScreen.style.display = 'none';
                }, 400);
            } else {
                // Failure! Show error and shake the card aggressively
                errorText.style.display = 'block';
                card.style.transform = 'translateX(-10px)';
                setTimeout(() => card.style.transform = 'translateX(10px)', 50);
                setTimeout(() => card.style.transform = 'translateX(-10px)', 100);
                setTimeout(() => card.style.transform = 'translateX(10px)', 150);
                setTimeout(() => card.style.transform = 'translateX(0)', 200);
            }
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

        function switchTab(tabId) {
            document.querySelectorAll('.app-screen').forEach(screen => screen.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
            
            document.getElementById(tabId).classList.add('active');
            
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
        function updateLibraryUI() {
            const mainProgram = localStorage.getItem('activeProgram'); 
            
            // NEW: Inject Custom Programs dynamically
            const customFolderContent = document.getElementById('custom-folder-content');
            if (customFolderContent) {
                const customProgs = safeParse('customPrograms', {});
                let html = `<button class="action-btn btn-start" style="padding: 12px; margin-bottom: 15px; font-size: 14px; border-style: dashed;" onclick="startCustomWorkout()">+ Start Empty Workout</button>`;
                
                Object.keys(customProgs).forEach(pid => {
                    html += `
                    <div class="program-card" style="display: flex; justify-content: space-between; align-items: center;" onclick="startProgram('${pid}')">
                        <div>
                            <h3 class="program-title" style="margin-bottom: 4px;">${customProgs[pid].name}</h3>
                            <p class="program-desc">Custom Template</p>
                        </div>
                        <button onclick="event.stopPropagation(); deleteCustomProgram('${pid}')" style="background: rgba(239, 68, 68, 0.1); color: var(--danger); border: none; padding: 10px; border-radius: 8px; cursor: pointer; transition: 0.2s;">🗑️</button>
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
                const title = card.querySelector('.program-title');
                
                const existingBadge = title.querySelector('.active-badge');
                if (existingBadge) existingBadge.remove();

                if (pid === mainProgram && !isProgramFinished(pid)) {
                    card.style.borderColor = 'var(--accent)';
                    title.innerHTML += ' <span class="active-badge" style="color: var(--accent); font-size: 11px; font-weight: 800; vertical-align: top; margin-left: 6px; padding: 2px 6px; background: rgba(249, 115, 22, 0.1); border-radius: 4px;">ACTIVE</span>';
                } else {
                    card.style.borderColor = 'var(--border)';
                }
            });
        }

        window.updateBodyweight = function(val) {
            let bw = parseFloat(val);
            if (!isNaN(bw) && bw > 0) {
                localStorage.setItem('userBodyweight', bw);
            } else {
                localStorage.removeItem('userBodyweight');
            }
            renderStats(); // Auto-update the DOTS score when you type
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
                    setTimeout(() => { progFill.style.width = `${(doneDays / totalDays) * 100}%`; }, 100);
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

        function getResolved1RM(exName) {
            let saved1RMs = safeParse('global1RMs', {});
            if (saved1RMs[exName]) return saved1RMs[exName];
            
            const lowerName = exName.toLowerCase();
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
                
                activeWorkout = { key, program: currentProgram, week: selectedWeek, day: selectedDay, startTime: Date.now() };
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
                activeWorkout = { key, program: currentProgram, week: selectedWeek, day: selectedDay, startTime: Date.now() };
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
                container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding-top:50px; font-size: 13px; font-style: italic;">Complete a workout to plot progress.</div>'; 
                return; 
            }
            
            let exName = currentChartEx;
            let history = safeParse('workoutHistory', []).slice().reverse(); 
            
            // --- NEW: e1RM CALCULATION ENGINE FOR PLOTTING ---
            const getE1RM = (weight, reps, rpe) => {
                if (!weight || weight <= 0 || !reps || reps <= 0) return 0;
                
                const rtsChart = {
                    10:   [1.000, 0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675],
                    9.5:  [0.975, 0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650],
                    9:    [0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650],
                    8.5:  [0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625],
                    8:    [0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625],
                    7.5:  [0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600],
                    7:    [0.875, 0.850, 0.850, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600],
                    6.5:  [0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600, 0.575],
                    6:    [0.850, 0.825, 0.800, 0.775, 0.750, 0.700, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575],
                    5.5:  [0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.625, 0.600, 0.575, 0.550],
                    5:    [0.825, 0.800, 0.800, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575, 0.550]
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

            let data = [];
            history.forEach(log => {
                let exMatch = log.details.find(e => e.name === exName);
                if(exMatch && exMatch.sets && exMatch.sets.length > 0) {
                    // Calculate e1RM for every set in the workout and plot the highest one
                    let maxE1RM = Math.max(...exMatch.sets.map(s => getE1RM(s.load, s.reps, s.rpe)));
                    if(maxE1RM > 0) data.push({ value: parseFloat(maxE1RM.toFixed(1)) });
                }
            });
            
            if(data.length < 2) {
                container.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding-top:50px; font-size:13px; font-style: italic;">Need 2 sessions of this lift to plot progress.</div>`;
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
            
            let circles = data.map((d, i) => {
                let x = (i / (data.length - 1)) * (w - 40) + 20;
                let y = h - padding - ((d.value - minV) / range) * (h - 2 * padding);
                return `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2"/>
                        <text x="${x}" y="${y - 12}" fill="var(--text-main)" font-size="11" font-weight="800" text-anchor="middle" font-family="Inter">${d.value}kg</text>`;
            }).join('');
            
            container.innerHTML = `<svg width="100%" height="${h}" style="overflow:visible;">
                                      ${gridHtml}
                                      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                      ${circles}
                                   </svg>`;
        };

    function renderHistory() {
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
                                <span>${set.load}kg x ${set.reps}</span>
                                <span>${rpeText}</span>
                            </div>`;
                        });
                    });
                    detailsHtml += `</div>`;
                } else {
                    detailsHtml = `<div class="history-details"><div class="hd-set-row"><span>No detailed set data available for this legacy log.</span></div></div>`;
                }

                return `
                <details class="history-card">
                    <summary class="history-summary">
                        <span class="history-date">${log.date}</span>
                        <h3 class="history-title">${log.programName} (W${log.week} D${log.day})</h3>
                        <div class="history-stats">${log.sets} Sets • ${log.volume.toLocaleString()} kg Volume</div>
                        <button class="history-delete" onclick="event.preventDefault(); deleteHistoryLog('${log.id}', '${log.key}')">🗑️</button>
                        <div class="history-expand-indicator">▼ Expand</div>
                    </summary>
                    ${detailsHtml}
                </details>
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
                bindSwipe(el, -80, () => resetSpecificLift(el.dataset.exname));
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

        window.togglePhysiquePrivacy = function() {
            window.physiquePrivacy = !window.physiquePrivacy;
            const gallery = document.getElementById('physique-gallery');
            const btn = document.getElementById('privacy-toggle-btn');
            
            if (window.physiquePrivacy) {
                gallery.classList.add('privacy-hidden');
                btn.innerText = '🙈 Hidden';
                btn.style.color = 'var(--text-muted)';
                btn.style.borderColor = 'var(--border)';
            } else {
                gallery.classList.remove('privacy-hidden');
                btn.innerText = '👁️ Revealed';
                btn.style.color = 'var(--accent)';
                btn.style.borderColor = 'var(--accent)';
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
        function renderStats() {
            const statsContainer = document.getElementById('stats-container');
            let global1RMs = safeParse('global1RMs', {});
            let actualBests = safeParse('actualBests', {});

            if (!global1RMs['Squat']) global1RMs['Squat'] = 0;
            if (!global1RMs['Bench Press']) global1RMs['Bench Press'] = 0;
            if (!global1RMs['Deadlift']) global1RMs['Deadlift'] = 0;

            const savedBw = localStorage.getItem('userBodyweight') || '';

            const savedGender = localStorage.getItem('userGender') || 'M';
            const sbdTotal = (global1RMs['Squat'] || 0) + (global1RMs['Bench Press'] || 0) + (global1RMs['Deadlift'] || 0);
            const dotsScore = savedBw ? calculateDOTS(parseFloat(savedBw), sbdTotal, savedGender) : 0;

            let html = '<h3 style="color: var(--text-main); font-size: 18px; margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Lifter Profile</h3>';
            
            html += `
            <div class="stat-card" style="padding: 16px; display: flex; flex-direction: column; gap: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div style="flex: 1;"><span class="stat-name">Bodyweight</span></div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <input type="number" class="input-box" style="width: 70px; padding: 8px; font-size: 16px;" value="${savedBw}" placeholder="--" onchange="updateBodyweight(this.value)" inputmode="decimal">
                        <span style="color: var(--text-muted); font-size: 14px; font-weight: 600;">kg</span>
                        
                        <select class="input-box" style="width: 50px; padding: 8px; font-size: 14px; margin-left: 5px; appearance: none; text-align: center;" onchange="updateGender(this.value)">
                            <option value="M" ${savedGender === 'M' ? 'selected' : ''}>M</option>
                            <option value="F" ${savedGender === 'F' ? 'selected' : ''}>F</option>
                        </select>
                    </div>
                </div>
                
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-top: 1px dashed var(--border); padding-top: 15px;">
                    <div style="text-align: center; flex: 1; border-right: 1px dashed var(--border);">
                        <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 800; letter-spacing: 1px; margin-bottom: 4px;">SBD Total</div>
                        <div style="font-size: 22px; font-weight: 900; color: var(--text-main);">${sbdTotal > 0 ? sbdTotal + ' kg' : '--'}</div>
                    </div>
                    <div style="text-align: center; flex: 1;">
                        <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 800; letter-spacing: 1px; margin-bottom: 4px;">DOTS Score</div>
                        <div style="font-size: 22px; font-weight: 900; color: #eab308;">${dotsScore > 0 ? dotsScore : '--'}</div>
                    </div>
                </div>
            </div>`;

            html += '<h3 style="color: var(--text-main); font-size: 18px; margin-top: 30px; margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">Current Baselines</h3>';
            html += '<p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">These 1RM values drive your percentage-based targets.</p>';

            const sorted1RMs = Object.keys(global1RMs).sort();
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

            html += '<h3 style="color: var(--text-main); font-size: 18px; margin-top: 40px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">All-Time Heaviest Lifts</h3>';

            const bestKeys = Object.keys(actualBests).sort();
            if (bestKeys.length === 0) {
                html += '<div class="empty-stats" style="color: var(--text-muted); font-style: italic; font-size: 14px; text-align: center; padding: 20px;">No completed sets logged yet. Your heaviest actual lifts will automatically appear here.</div>';
            } else {
                bestKeys.forEach(ex => {
                    const b = actualBests[ex];
                    const safeExHTML = ex.replace(/"/g, '&quot;');
                    html += `
                    <div class="swipe-wrapper stat-swipe">
                        <div class="swipe-delete-bg" style="right: 15px;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </div>
                        <div class="stat-card stat-swipable" style="padding: 16px 18px; margin-bottom: 0;" data-exname="${safeExHTML}">
                            <span class="stat-name" style="flex: 1; padding-right: 15px; word-break: break-word; line-height: 1.3;">${ex}</span>
                            <div style="display: flex; align-items: center; gap: 12px; flex-shrink: 0; white-space: nowrap;">
                                <span class="stat-value" style="color: var(--teal); white-space: nowrap;">${b.weight} kg <span style="font-size: 14px; color: var(--text-muted);">x ${b.reps}</span></span>
                            </div>
                        </div>
                    </div>`;
                });
            }

            // Reset privacy lock every time the vault is opened
            window.physiquePrivacy = true;

            // --- NEW: PHYSIQUE TRACKING UI ---
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
            // ---------------------------------

            statsContainer.innerHTML = html;
            
            // Turn on the swipe engine for the newly drawn cards!
            if (typeof setupStatsSwipe === 'function') setupStatsSwipe();
            
            // Render the gallery asynchronously
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
            
            if (!targetWeight || targetWeight <= 0) {
                alert("⚠️ Please enter your working weight in the first set block before generating warmups!");
                return;
            }
            
            // Set default scheme: 5 sets for main lifts, 2 for accessories
            if (!scheme) scheme = isMain ? 5 : 2;

            document.getElementById('warmup-title').innerText = `${exName} Warm-up`;
            
            // Build the Toggle Pills
            let html = `
                <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 15px;">
                    <button class="pill ${scheme === 5 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 5)" style="flex: 1; justify-content: center;">5 Sets</button>
                    <button class="pill ${scheme === 3 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 3)" style="flex: 1; justify-content: center;">3 Sets</button>
                    <button class="pill ${scheme === 2 ? 'active' : ''}" onclick="openWarmupGenerator('${exId}', '${exName.replace(/'/g, "\\'")}', ${isMain}, 2)" style="flex: 1; justify-content: center;">2 Sets</button>
                </div>
                <table class="warmup-table" style="margin-bottom: 20px;">
                    <tr><th>Set</th><th>Load</th><th>Reps</th></tr>
            `;
            
            let sets = [];
            const roundToPlate = (w) => Math.round(w / 2.5) * 2.5;

            // Define the Pyramids
            if (scheme === 5) {
                sets = [
                    { label: targetWeight > 20 ? "Empty Bar (20)" : "Light", load: targetWeight > 20 ? 20 : roundToPlate(targetWeight*0.3), reps: 10 },
                    { load: roundToPlate(targetWeight * 0.4), reps: 5 },
                    { load: roundToPlate(targetWeight * 0.6), reps: 3 },
                    { load: roundToPlate(targetWeight * 0.75), reps: 2 },
                    { load: roundToPlate(targetWeight * 0.85), reps: 1 }
                ];
            } else if (scheme === 3) {
                sets = [
                    { label: targetWeight > 20 ? "Empty Bar (20)" : "Light", load: targetWeight > 20 ? 20 : roundToPlate(targetWeight*0.4), reps: 8 },
                    { load: roundToPlate(targetWeight * 0.6), reps: 3 },
                    { load: roundToPlate(targetWeight * 0.8), reps: 1 }
                ];
            } else {
                // 2-set scheme for accessories
                sets = [
                    { load: roundToPlate(targetWeight * 0.5), reps: 6 },
                    { load: roundToPlate(targetWeight * 0.75), reps: 3 }
                ];
            }

            // Build the Table Rows
            sets.forEach((s, i) => {
                let displayLoad = s.label ? s.label : `${Math.max(0, s.load)} kg`;
                html += `<tr><td>${i + 1}</td><td>${displayLoad}</td><td>${s.reps}</td></tr>`;
            });
            
            html += `<tr><td>Work</td><td>${targetWeight} kg</td><td>Target</td></tr>`;
            html += `</table>`;
            
            // Build the Action Buttons
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

        function renderWorkout() {
            const container = document.getElementById('workout-container');
            container.innerHTML = '';
            
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
                            
                            <h2 class="ex-title" onclick="${!isNonExercise ? `openHistoryOverlay('${ex.name.replace(/'/g, "\\'")}')` : ''}" style="${isNonExercise ? 'padding: 0 10px; text-align: center; width: 100%;' : 'cursor:pointer; border-bottom: 1px dashed rgba(255,255,255,0.2); padding-bottom: 2px; margin-bottom: -3px; display: inline-block;'}">
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
                        
                        ${displayNotesHtml}
                        
                        ${isMain && !isNonExercise ? `<div class="global-e1rm" id="global-e1rm-${exId}">${historical1RM}</div>` : ''}
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
                                <span>Set</span><span>Reps</span><span>RPE</span><span>Load</span>${isMain ? '<span>e1RM</span>' : ''}<span></span>
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
                            smartDefaultLoad = Math.round((resolved1RM * block.pct) / 2.5) * 2.5;
                        } else if (!block.pct && lastUsedWeights[ex.name]) {
                            // NEW: Smart look-up per set!
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

                        let e1rmCell = '';
                        if (isMain) {
                            e1rmCell = `<span><button class="e1rm-btn" id="e1rm-btn-${rowId}" data-exid="${exId}" data-exname="${ex.name}" data-rowid="${rowId}" data-e1rm="0"><span class="e1rm-label">Calc</span><span class="e1rm-value">--</span></button></span>`;
                        }

                        const repsClass = 'input-box saveable calc-trigger'; 
                        const rpeClass = 'input-box input-rpe saveable calc-trigger';
                        const loadClass = `input-box saveable calc-trigger ${isMain ? 'main-load' : 'acc-load'}`;

                        let setHtml = `
                        <div class="set-row" style="${!isMain ? 'grid-template-columns: 0.8fr 1fr 1.2fr 1.5fr 1.6fr 0.8fr;' : ''}">
                            <span>${s}</span>
                            <span><input type="number" id="${repsInputId}" class="${repsClass}" data-rowid="${rowId}" value="${repsValue}" inputmode="numeric" ${disabledAttr}></span>
                            <span><input type="number" id="${rpeInputId}" class="${rpeClass}" data-rowid="${rowId}" value="${rpeValue}" step="0.5" inputmode="decimal" ${disabledAttr}></span>
                            <span style="position:relative; display:flex; align-items:center; justify-content:center; width: 100%;">
                                <input type="number" id="${loadInputId}" class="${loadClass}" data-rowid="${rowId}" data-pct="${block.pct || ''}" data-exname="${ex.name}" data-exid="${exId}" value="${loadValue}" placeholder="kg" inputmode="decimal" style="width: 100%;" ${disabledAttr}>
                                ${isNoPlateExercise(ex.name) ? '' : `
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
                            const setLabel = isLatestExtra ? 
                                `<span style="color: ${themeColor}; font-size: 11px; line-height: 1; text-align: center; font-weight:800;">TARGET<br>SET</span>` : 
                                `<span>${s}.${eIdx + 1}</span>`;
                                
                            const borderStyle = isLatestExtra ? `border: 1px dashed ${themeColor};` : `border: 1px solid transparent;`;

                            html += `
                            <div class="set-row" style="${borderStyle} margin-top: 8px; ${!isMain ? 'grid-template-columns: 0.8fr 1fr 1.2fr 1.5fr 1.6fr 0.8fr;' : ''}">
                                ${setLabel}
                                <span><input type="number" id="${extraRowId}_reps" class="input-box saveable calc-trigger" data-rowid="${extraRowId}" value="${eRepsValue}" inputmode="numeric" ${eDisabledAttr}></span>
                                <span><input type="number" id="${extraRowId}_rpe" class="input-box saveable calc-trigger" style="color: ${themeColor}; opacity: ${eDisabledAttr ? '0.6' : '1'}; -webkit-text-fill-color: ${eDisabledAttr ? themeColor : ''};" data-rowid="${extraRowId}" value="${eRpeValue}" step="0.5" inputmode="decimal" ${eDisabledAttr}></span>
                                <span style="position:relative; display:flex; align-items:center; justify-content:center; width: 100%;">
                                    <input type="number" id="${extraRowId}_load" class="input-box saveable calc-trigger ${isMain ? 'main-load' : 'acc-load'}" data-rowid="${extraRowId}" data-exname="${ex.name}" data-exid="${exId}" value="${eLoadValue}" placeholder="kg" inputmode="decimal" style="width: 100%;" ${eDisabledAttr}>
                                    ${isNoPlateExercise(ex.name) ? '' : `
                                    <button class="plate-btn" onclick="togglePlateBalloon(event, '${extraRowId}_load')" title="Calculate Plates">
                                        <div class="plate-indicator"></div>
                                    </button>`}
                                </span>
                                ${isMain ? `<span><button class="e1rm-btn" id="e1rm-btn-${extraRowId}" data-exid="${exId}" data-exname="${ex.name}" data-rowid="${extraRowId}" data-e1rm="0"><span class="e1rm-label">Calc</span><span class="e1rm-value">--</span></button></span>` : ''}
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
            };

            const onThumbMove = (e) => {
                if (!isDraggingThumb) return;
                if (e.cancelable) e.preventDefault(); 
                
                let currentX = e.type.includes('mouse') ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
                let diff = currentX - startX;
                
                if (diff < 0) diff = 0;
                if (diff > maxSlide) diff = maxSlide;
                
                thumb.style.transform = `translateX(${diff}px)`;
                track.style.width = `${diff + 38}px`; 
                
                const text = container.querySelector('.slider-text');
                if (text) text.style.opacity = 1 - (diff / maxSlide);

                if (diff >= maxSlide - 5) {
                    isDraggingThumb = false;
                    toggleWorkoutState('finish');
                }
            };

            const onThumbEnd = () => {
                if (!isDraggingThumb) return;
                isDraggingThumb = false;
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
                plates.forEach(p => {
                    let h = p.w >= 20 ? 54 : p.w >= 15 ? 46 : p.w >= 10 ? 36 : p.w >= 5 ? 26 : p.w >= 2.5 ? 20 : 16;
                    let w = p.w >= 10 ? 14 : 10;
                    let f = p.w >= 10 ? 9 : 8;
                    html += `<div style="width: ${w}px; height: ${h}px; background: ${p.c}; border-radius: 2px; border: 1px solid rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; margin-right: 1px; flex-shrink: 0; box-shadow: inset -1px 0 3px rgba(0,0,0,0.3); z-index: 3;">
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
            const sign = timeLeft < 0 ? "-" : "";
            document.getElementById('timer-display').innerText = `${sign}${m}:${s}`;
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
                    
                    const exName = loadInput.dataset.exname;
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
                        
                        let oldRecord = actualBests[exName];
                        if (!oldRecord || val > oldRecord.weight || (val === oldRecord.weight && reps > oldRecord.reps)) {
                            
                            // Detect if this is a PR (only fire if beating a previously established record)
                            if (oldRecord) {
                                fireConfetti();
                                showPRToast(exName, val, reps);
                            }
                            
                            actualBests[exName] = { weight: val, reps: reps };
                            localStorage.setItem('actualBests', JSON.stringify(actualBests));
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
                    10:   [1.000, 0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675],
                    9.5:  [0.975, 0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650],
                    9:    [0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650],
                    8.5:  [0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625],
                    8:    [0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625],
                    7.5:  [0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600],
                    7:    [0.875, 0.850, 0.850, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600],
                    6.5:  [0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600, 0.575],
                    6:    [0.850, 0.825, 0.800, 0.775, 0.750, 0.700, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575],
                    5.5:  [0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.625, 0.600, 0.575, 0.550],
                    5:    [0.825, 0.800, 0.800, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575, 0.550]
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
                let targetEffectiveWeight = Math.round((e1rm * targetPct) / 2.5) * 2.5;
                
                let newWeight = targetEffectiveWeight;
                if (isBodyweightExercise(ex.name)) {
                    const bw = parseFloat(localStorage.getItem('userBodyweight')) || 0;
                    if (bw > 0) newWeight = Math.max(0, targetEffectiveWeight - bw); // Subtract BW back out so it just tells you the added plate weight!
                }

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
                        const exName = e.target.dataset.exname;
                        
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

                const exName = loadInput.dataset.exname; // BUG FIX: Defines the exercise name so the engine doesn't crash!

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
                        10:   [1.000, 0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675],
                        9.5:  [0.975, 0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650],
                        9:    [0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650],
                        8.5:  [0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625],
                        8:    [0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625],
                        7.5:  [0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600],
                        7:    [0.875, 0.850, 0.850, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600],
                        6.5:  [0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600, 0.575],
                        6:    [0.850, 0.825, 0.800, 0.775, 0.750, 0.700, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575],
                        5.5:  [0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.625, 0.600, 0.575, 0.550],
                        5:    [0.825, 0.800, 0.800, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575, 0.550]
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
                    
                    const e1rm = weight / percentage;

                    btn.innerHTML = `<span class="e1rm-label">e1RM</span><span class="e1rm-value">${e1rm.toFixed(1)}</span>`;
                    btn.dataset.e1rm = e1rm; 
                    btn.classList.add('ready');
                } else {
                    btn.innerHTML = `<span class="e1rm-label">Calc</span><span class="e1rm-value">--</span>`;
                    btn.dataset.e1rm = "0"; 
                    btn.classList.remove('ready');
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
                    const exName = currentBtn.dataset.exname;
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

                        document.querySelectorAll(`.main-load[data-exid="${exId}"]`).forEach(loadInput => {
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
                                        10:   [1.000, 0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675],
                                        9.5:  [0.975, 0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650],
                                        9:    [0.950, 0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650],
                                        8.5:  [0.925, 0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625],
                                        8:    [0.925, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625],
                                        7.5:  [0.900, 0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600],
                                        7:    [0.875, 0.850, 0.850, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600],
                                        6.5:  [0.875, 0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.650, 0.625, 0.600, 0.575],
                                        6:    [0.850, 0.825, 0.800, 0.775, 0.750, 0.700, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575],
                                        5.5:  [0.850, 0.825, 0.800, 0.775, 0.750, 0.725, 0.700, 0.675, 0.625, 0.600, 0.575, 0.550],
                                        5:    [0.825, 0.800, 0.800, 0.750, 0.725, 0.700, 0.675, 0.650, 0.625, 0.600, 0.575, 0.550]
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
                                let targetWeight = Math.round((e1rm * targetPct) / 2.5) * 2.5;
                                
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
                let cls = isDone ? 's-dot active' : 's-dot';
                let content = isDone ? '✓' : dayLabels[i];
                
                // Dim future days so you know the week isn't over yet
                if (d.getTime() > today.getTime()) {
                    html += `<div class="streak-day"><div class="s-dot" style="opacity: 0.3;">${dayLabels[i]}</div></div>`;
                } else {
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
                "Are you sure you want to cancel this active session? Your entered data for today will be cleared.",
                "Stop Workout",
                "Keep Lifting",
                true
            );
            if (confirmed) {
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

        initApp();