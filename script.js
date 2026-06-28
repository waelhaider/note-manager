// Firebase SDK & Configuration
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';

// Initialize Firebase App, Auth, and Firestore
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(firebaseApp);
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/userinfo.email');

// Auth states cached in memory
let currentUser = null;
let googleAccessToken = null;
let isOwner = false; // By default read-only (spectator mode) until confirmed as owner in database
let ownerEmail = null;
let googleDriveFileId = null;

// Premium Membership & Licensing States
let isAllFree = false;          // True if owner opens the entire app for everyone (gift option)
let currentUserLicense = null;  // Holds license details {email, activated, activationCode, trialStartDate}
let isUserPremium = false;      // True if the user has premium access (active trial, active license, or owner)
let trialDaysSetting = 7;       // Default trial duration in days (can be changed by owner)
let isOwnerPanelOpen = false;   // Owner license manager collapsible toggle state

// Firebase & Drive Helper Functions
async function firestoreWriteNote(note) {
    if (!db || !isOwner || note.boardId === 'local_user') return;
    try {
        await setDoc(doc(db, "notes", note.id), note);
    } catch (err) {
        console.error("Firestore write note error: ", err);
    }
}

async function firestoreDeleteNote(noteId) {
    if (!db || !isOwner) return;
    const note = notes.find(n => n.id === noteId);
    if (note && note.boardId === 'local_user') return;
    try {
        await deleteDoc(doc(db, "notes", noteId));
    } catch (err) {
        console.error("Firestore delete note error: ", err);
    }
}

async function firestoreWriteTrash(item) {
    if (!db || !isOwner || item.boardId === 'local_user') return;
    try {
        await setDoc(doc(db, "trash", item.id), item);
    } catch (err) {
        console.error("Firestore write trash error: ", err);
    }
}

async function firestoreDeleteTrash(itemId) {
    if (!db || !isOwner) return;
    const item = trash.find(t => t.id === itemId);
    if (item && item.boardId === 'local_user') return;
    try {
        await deleteDoc(doc(db, "trash", itemId));
    } catch (err) {
        console.error("Firestore delete trash error: ", err);
    }
}

async function firestoreWriteBoard(board) {
    if (!db || !isOwner || board.id === 'local_user') return;
    try {
        await setDoc(doc(db, "boards", board.id), board);
    } catch (err) {
        console.error("Firestore write board error: ", err);
    }
}

async function firestoreDeleteBoard(boardId) {
    if (!db || !isOwner || boardId === 'local_user') return;
    try {
        await deleteDoc(doc(db, "boards", boardId));
    } catch (err) {
        console.error("Firestore delete board error: ", err);
    }
}

async function firestoreClearTrash() {
    if (!db || !isOwner) return;
    try {
        const querySnapshot = await getDocs(collection(db, "trash"));
        for (const d of querySnapshot.docs) {
            await deleteDoc(doc(db, "trash", d.id));
        }
    } catch (err) {
        console.error("Firestore clear trash error: ", err);
    }
}

async function uploadAllToFirestore() {
    if (!db || !isOwner) return;
    try {
        for (const board of boards) {
            if (board.id === 'local_user') continue;
            await setDoc(doc(db, "boards", board.id), board);
        }
        for (const note of notes) {
            if (note.boardId === 'local_user') continue;
            await setDoc(doc(db, "notes", note.id), note);
        }
        for (const item of trash) {
            if (item.boardId === 'local_user') continue;
            await setDoc(doc(db, "trash", item.id), item);
        }
    } catch (e) {
        console.error("Failed to upload all to Firestore:", e);
    }
}

// Google Drive Sync API Utilities (Direct Fetch Integration)
async function findBackupFileOnDrive(token) {
    try {
        const url = "https://www.googleapis.com/drive/v3/files?q=name='clipboard_manager_backup.json' and trashed=false&fields=files(id,name)";
        const res = await fetch(url, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.files && data.files.length > 0) {
            return data.files[0].id;
        }
    } catch (e) {
        console.error("Error searching Google Drive:", e);
    }
    return null;
}

async function downloadBackupFromDrive(token, fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    return await res.json();
}

async function uploadBackupToDrive(token, fileId) {
    const metadata = {
        name: "clipboard_manager_backup.json",
        mimeType: "application/json"
    };
    const cloudBoards = boards.filter(b => b.id !== 'local_user');
    const cloudNotes = notes.filter(n => n.boardId !== 'local_user');
    const cloudTrash = trash.filter(t => t.boardId !== 'local_user');
    const content = JSON.stringify({ boards: cloudBoards, notes: cloudNotes, trash: cloudTrash });
    
    try {
        if (fileId) {
            const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
            await fetch(url, {
                method: "PATCH",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: content
            });
        } else {
            const boundary = "foo_bar_boundary";
            const delimiter = `\r\n--${boundary}\r\n`;
            const closeDelimiter = `\r\n--${boundary}--`;
            
            const multipartRequestBody = 
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                content +
                closeDelimiter;
                
            const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": `multipart/related; boundary=${boundary}`
                },
                body: multipartRequestBody
            });
            const data = await res.json();
            if (data.id) {
                googleDriveFileId = data.id;
            }
        }
    } catch (e) {
        console.error("Error backing up to Google Drive:", e);
    }
}

// Upload Audio File to Google Drive
async function uploadAudioToDrive(token, file) {
    const metadata = {
        name: `clipboard_audio_${Date.now()}_${file.name}`,
        mimeType: file.type
    };

    // Step 1: Create file metadata
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(metadata)
    });
    
    if (!createRes.ok) {
        throw new Error("Failed to create file on Google Drive");
    }
    
    const fileData = await createRes.json();
    const fileId = fileData.id;
    if (!fileId) throw new Error("Failed to create file on Google Drive");

    // Step 2: Upload file media
    const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: "PATCH",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": file.type
        },
        body: file
    });
    
    if (!uploadRes.ok) {
        throw new Error("Failed to upload file media to Google Drive");
    }

    // Step 3: Set permission to 'anyone' reader so anyone with the link can play it
    try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                role: "reader",
                type: "anyone"
            })
        });
    } catch (permErr) {
        console.error("Error setting public permissions:", permErr);
    }

    return fileId;
}

// UI restrictions and sync loaders
function applyOwnershipUIRestrictions() {
    const flexDisplayVal = isOwner ? 'flex' : 'none';
    const sidebarAddBtn = document.getElementById('add-board-btn');
    if (sidebarAddBtn) sidebarAddBtn.style.display = flexDisplayVal;
    
    const sidebarReorderBtn = document.getElementById('reorder-boards-btn');
    if (sidebarReorderBtn) sidebarReorderBtn.style.display = flexDisplayVal;
    
    const exportIds = ['export-btn', 'export-board-btn', 'import-btn', 'import-board-btn', 'import-text-btn'];
    exportIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.style.display = flexDisplayVal;
    });
    
    const emptyTrash = document.getElementById('empty-trash-btn');
    if (emptyTrash) emptyTrash.style.display = isOwner ? 'block' : 'none';

    // Keep note input form visible for both owners and visitors
    const noteForm = document.getElementById('note-form');
    if (noteForm) {
        noteForm.style.display = 'flex';
    }

    const saveEditTranslate = document.getElementById('save-edit-translate');
    if (saveEditTranslate) {
        saveEditTranslate.style.display = isOwner ? 'block' : 'none';
    }
}

function updateSyncBadge() {
    const indicator = document.getElementById('sync-status-indicator');
    if (!indicator) return;
    
    if (currentUser && isOwner && ownerEmail) {
        indicator.innerHTML = `
            <div style="display: flex; gap: 6px; align-items: center; margin-right: -10px; margin-left: 5px;">
                <span id="badge-sync-trigger" style="display: inline-block; width: 14px; height: 14px; background-color: #10b981; border: 2px solid #059669; border-radius: 50%; cursor: pointer; transition: transform 0.2s;" title="مزامنة تلقائية نشطة (أنقر للمزامنة اليدوية الإضافية)"></span>
            </div>
        `;
        const trigger = document.getElementById('badge-sync-trigger');
        if (trigger) {
            trigger.onclick = async () => {
                try {
                    trigger.style.backgroundColor = '#f59e0b'; // Amber to show syncing
                    trigger.style.borderColor = '#d97706';
                    trigger.style.pointerEvents = 'none';
                    await uploadAllToFirestore();
                    if (googleAccessToken) {
                        try {
                            await uploadBackupToDrive(googleAccessToken, googleDriveFileId);
                        } catch (driveErr) {
                            console.error("Drive sync failed during header sync:", driveErr);
                        }
                    }
                    showToast("تمت المزامنة وحفظ التعديلات بنجاح! ☁️");
                } catch (err) {
                    console.error("Header sync failed:", err);
                    showToast("فشلت المزامنة المباشرة، يرجى المحاولة لاحقاً");
                } finally {
                    trigger.style.pointerEvents = 'auto';
                    updateSyncBadge();
                }
            };
        }
    } else if (ownerEmail && !isOwner) {
        indicator.innerHTML = `
            <div style="display: flex; gap: 6px; align-items: center; margin-right: -10px; margin-left: 5px;">
                <span style="display: inline-block; width: 14px; height: 14px; background-color: #ef4444; border: 2px solid #dc2626; border-radius: 50%; cursor: not-allowed;" title="أنت تتصفح نصوص المالك في وضع القراءة فقط"></span>
            </div>
        `;
    } else {
        indicator.innerHTML = ``;
    }
}

// Premium Membership & Licensing Helpers
function showTrialBanner(daysLeft) {
    let mainContainer = document.querySelector('.main');
    if (!mainContainer) return;
    
    let trialBanner = document.getElementById('trial-banner-indicator');
    if (!trialBanner) {
        trialBanner = document.createElement('div');
        trialBanner.id = 'trial-banner-indicator';
        trialBanner.style.cssText = 'background: #e0f2fe; border: 1px solid #bae6fd; padding: 1px; margin: 0; border-radius: 8px; text-align: center; color: #0369a1; font-size: 10px; font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 2px; box-sizing: border-box;';
        mainContainer.insertBefore(trialBanner, mainContainer.firstChild);
    }
    trialBanner.innerHTML = `نسخة كاملة مجانية لمشاهدة العمل  .. <span style="color: #ef4444;"><b>(${daysLeft}  يوم </b> على انتهاء التجربة )`;
}

function showGlobalGiftBanner() {
    let mainContainer = document.querySelector('.main');
    if (!mainContainer) return;
    
    let trialBanner = document.getElementById('trial-banner-indicator');
    if (!trialBanner) {
        trialBanner = document.createElement('div');
        trialBanner.id = 'trial-banner-indicator';
        trialBanner.style.cssText = 'background: #f0fdf4; border: 1px solid #bbf7d0; padding: 10px; margin: 0; border-radius: 8px; text-align: center; color: #166534; font-size: 13px; font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box;';
        mainContainer.insertBefore(trialBanner, mainContainer.firstChild);
    }
    trialBanner.innerHTML = `🎁 هدية من المالك: تم فتح النسخة الكاملة مجاناً لفترة محدودة لجميع الزوار!`;
}

async function checkLicenseAndAccess() {
    isAllFree = false;
    currentUserLicense = null;
    isUserPremium = false;
    trialDaysSetting = 7; // Reset to default
    
    // 1. Get global settings to evaluate allFree and custom trial days
    try {
        const globalRef = doc(db, "settings", "global");
        const docSnap = await getDoc(globalRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            isAllFree = !!data.allFree;
            if (data.trialDays !== undefined && data.trialDays !== null) {
                const parsedDays = parseInt(data.trialDays, 10);
                if (!isNaN(parsedDays) && parsedDays > 0) {
                    trialDaysSetting = parsedDays;
                }
            }
        }
    } catch (e) {
        console.error("Failed to read global free access mode:", e);
    }

    // 2. Clear trial banner/indicator if any
    let trialBanner = document.getElementById('trial-banner-indicator');
    if (trialBanner) trialBanner.remove();

    // 3. Evaluate premium access
    if (isOwner) {
        isUserPremium = true;
    } else if (isAllFree) {
        isUserPremium = true;
        showGlobalGiftBanner();
    } else if (currentUser) {
        const normalizedEmail = currentUser.email.toLowerCase().trim();
        try {
            const licenseRef = doc(db, "licenses", normalizedEmail);
            const licenseDoc = await getDoc(licenseRef);
            if (licenseDoc.exists()) {
                currentUserLicense = licenseDoc.data();
                // If the license exists (e.g. pre-assigned by the owner) but has no trial start date yet, initialize it today
                if (!currentUserLicense.trialStartDate && !currentUserLicense.activated) {
                    currentUserLicense.trialStartDate = Date.now();
                    await setDoc(licenseRef, currentUserLicense, { merge: true });
                }
            } else {
                // First login, start trial
                const trialStart = Date.now();
                currentUserLicense = {
                    email: normalizedEmail,
                    activated: false,
                    activationCode: "", // blank initially, owner can set in panel
                    trialStartDate: trialStart,
                    expiryDate: null
                };
                await setDoc(licenseRef, currentUserLicense);
            }
            
            if (currentUserLicense.activated) {
                isUserPremium = true;
            } else if (currentUserLicense.trialStartDate) {
                const elapsed = Date.now() - currentUserLicense.trialStartDate;
                const trialDuration = trialDaysSetting * 24 * 60 * 60 * 1000;
                if (elapsed < trialDuration) {
                    isUserPremium = true;
                    const daysLeft = Math.max(1, Math.ceil((trialDuration - elapsed) / (24 * 60 * 60 * 1000)));
                    showTrialBanner(daysLeft);
                } else {
                    isUserPremium = false;
                }
            } else {
                isUserPremium = false;
            }
        } catch (err) {
            console.error("Firestore loading license exception:", err);
            isUserPremium = false;
        }
    } else {
        isUserPremium = false;
    }
}

async function renderOwnerLicenseManager() {
    const container = document.getElementById('owner-license-manager-container');
    const parent = document.getElementById('owner-license-manager');
    if (!container || !parent) return;

    if (!isOwner || !currentUser) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    // Manage inner display and chevron based on isOwnerPanelOpen
    const chev = document.getElementById('owner-panel-chevron');
    parent.style.display = isOwnerPanelOpen ? 'block' : 'none';
    if (chev) {
        chev.style.transform = isOwnerPanelOpen ? 'rotate(180deg)' : 'rotate(0deg)';
    }

    // Set toggle click handler
    const toggleBtn = document.getElementById('owner-panel-toggle');
    if (toggleBtn) {
        toggleBtn.onclick = () => {
            isOwnerPanelOpen = !isOwnerPanelOpen;
            parent.style.display = isOwnerPanelOpen ? 'block' : 'none';
            if (chev) {
                chev.style.transform = isOwnerPanelOpen ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        };
    }
    
    // Fetch licenses list from Firestore
    let licensesList = [];
    try {
        const snap = await getDocs(collection(db, "licenses"));
        snap.forEach(docSnap => {
            licensesList.push(docSnap.data());
        });
    } catch (e) {
        console.error("Owner cannot read licenses:", e);
    }

    parent.innerHTML = `
        <!-- Toggle global free gift status -->
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 12px; direction: rtl; font-size: 11.5px;">
            <input type="checkbox" id="all-free-toggle" ${isAllFree ? 'checked' : ''} style="cursor: pointer; width: 14px; height: 14px; accent-color: #65a30d;">
            <label for="all-free-toggle" style="cursor: pointer; color: #3f6212; font-weight: bold;">🎁فتح العمل مجاناً للجميع كهدية</label>
        </div>

        <!-- Trial Days Config -->
        <div style="background: #f4f4f3; border-radius: 6px; padding: 6px; margin-bottom: 10px; direction: rtl;">
            <p style="font-size: 11px; font-weight: bold; margin-bottom: 4px; color: #1e293b;">مدة الفترة التجريبية:</p>
            <div style="display: flex; gap: 4px; align-items: center;">
                <input type="number" id="trial-days-input" value="${trialDaysSetting}" min="1" max="365" style="width: 55px; padding: 2px 4px; font-size: 11px; border: 1px solid #cbd5e1; border-radius: 4px; text-align: center;">
                <span style="font-size: 11px; color: #475569; font-weight: bold;">يوم</span>
                <button id="save-trial-days-btn" style="background: #0284c7; color: white; border: none; padding: 3px 6px; font-size: 10.5px; border-radius: 4px; cursor: pointer; font-weight: bold; margin-right: auto;">حفظ الأيام</button>
            </div>
        </div>

        <!-- Add Subscriber form -->
        <div style="background: #f4f4f3; border-radius: 6px; padding: 6px; margin-bottom: 10px; direction: rtl;">
            <p style="font-size: 11px; font-weight: bold; margin-bottom: 4px; color: #1e293b;">توليد كود تفعيل جديد:</p>
            <div style="display: flex; gap: 4px;">
                <input type="email" id="new-license-email" placeholder="بريد المشترك..." style="flex: 1; padding: 4px 6px; font-size: 11.5px; border: 1px solid #cbd5e1; border-radius: 4px;">
                <button id="add-license-code-btn" style="background: #65a30d; color: white; border: none; padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; font-weight: bold;">حفظ</button>
            </div>
        </div>

        <!-- Licensed emails lists -->
        <p style="font-size: 11px; font-weight: bold; color: #475569; margin-bottom: 4px; direction: rtl; text-align: right;">أكواد التفعيل المسجلة:</p>
        <div style="max-height: 160px; overflow-y: auto; direction: rtl; text-align: right;">
            ${licensesList.length === 0 ? '<p style="font-size: 10.5px; color: #94a3b8; text-align: center;">لا يوجد مشتركين مسجلين حالياً</p>' : ''}
            <div style="display: flex; flex-direction: column; gap: 4px;">
                ${licensesList.map(lic => {
                    let statusLabel = '';
                    let statusColor = '#475569';
                    if (lic.activated) {
                        statusLabel = 'مدفوع نشط';
                        statusColor = '#16a34a';
                    } else if (lic.trialStartDate) {
                        const elapsed = Date.now() - lic.trialStartDate;
                        const daysLeft = Math.max(0, Math.ceil((trialDaysSetting * 24 * 60 * 60 * 1000 - elapsed) / (24 * 60 * 60 * 1000)));
                        if (daysLeft > 0) {
                            statusLabel = `تجريبي (${daysLeft} يوم)`;
                            statusColor = '#0284c7';
                        } else {
                            statusLabel = 'تجربة منتهية 🚫';
                            statusColor = '#dc2626';
                        }
                    } else {
                        statusLabel = 'انتظار التنشيط';
                        statusColor = '#ea580c';
                    }
                    return `
                        <div style="box-shadow: 0 1px 2px rgba(0,0,0,0.02); background: white; border: 1px solid #e1e1de; border-radius: 4px; padding: 4px 6px; display: flex; flex-direction: column; gap: 2px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; gap: 4px;">
                                <span style="font-size: 10.5px; font-weight: bold; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; text-transform: lowercase;">${lic.email}</span>
                                <button class="delete-lic-btn" data-email="${lic.email}" style="background: none; border: none; font-size: 10.5px; color: #ef4444; cursor: pointer; padding: 2px;" title="حذف الاشتراك">🗑️</button>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #4b5563;">
                                <div>كود: <b style="color: #65a30d; font-family: monospace; font-size: 11px;">${lic.activationCode || 'بدون'}</b></div>
                                <div style="color: ${statusColor}; font-weight: bold;">${statusLabel}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    // Hook listeners
    const saveTrialDaysBtn = document.getElementById('save-trial-days-btn');
    if (saveTrialDaysBtn) {
        saveTrialDaysBtn.onclick = async () => {
            const input = document.getElementById('trial-days-input');
            const newDays = parseInt(input.value, 10);
            if (isNaN(newDays) || newDays < 1) {
                showToast("يرجى إدخال عدد أيام صحيح (أكبر من 0)");
                return;
            }
            saveTrialDaysBtn.disabled = true;
            saveTrialDaysBtn.textContent = "...";
            try {
                const globalRef = doc(db, "settings", "global");
                await setDoc(globalRef, {
                    trialDays: newDays,
                    lastSync: Date.now()
                }, { merge: true });
                trialDaysSetting = newDays;
                showToast(`🎉 تم تعديل الفترة التجريبية بنجاح لتكون ${newDays} يوماً!`);
                await checkLicenseAndAccess();
                await renderOwnerLicenseManager();
            } catch (e) {
                console.error("Failed to save trial days:", e);
                showToast("حدث خطأ أثناء حفظ الإعدادات سحابياً.");
            } finally {
                saveTrialDaysBtn.disabled = false;
                saveTrialDaysBtn.textContent = "حفظ الأيام";
            }
        };
    }

    const giftToggle = document.getElementById('all-free-toggle');
    if (giftToggle) {
        giftToggle.onchange = async () => {
            const isGift = giftToggle.checked;
            try {
                const globalRef = doc(db, "settings", "global");
                await setDoc(globalRef, {
                    ownerEmail: ownerEmail || currentUser.email,
                    ownerName: currentUser.displayName || '',
                    lastSync: Date.now(),
                    allFree: isGift
                }, { merge: true });
                isAllFree = isGift;
                showToast(isGift ? "🎁 تم تفعيل الهدية ترحيباً بالجميع!" : "🔒 تم تفعيل اشتراك الأعضاء المتميزين.");
                
                // Reload configuration and re-evaluate
                await loadCloudData();
            } catch (e) {
                console.error("Failed to toggle global free status:", e);
                showToast("حدث خطأ أثناء حفظ الإعدادات سحابياً.");
                giftToggle.checked = !isGift;
            }
        };
    }

    const addBtn = document.getElementById('add-license-code-btn');
    if (addBtn) {
        addBtn.onclick = async () => {
            const emailInput = document.getElementById('new-license-email');
            const targetMail = emailInput.value.trim().toLowerCase();
            if (!targetMail || !targetMail.includes('@')) {
                showToast("يرجى إدخال بريد إلكتروني صحيح");
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = "...";

            try {
                const actCode = Math.floor(100000 + Math.random() * 900000).toString();
                const licRef = doc(db, "licenses", targetMail);
                
                await setDoc(licRef, {
                    email: targetMail,
                    activationCode: actCode,
                    activated: false,
                    trialStartDate: null,
                    expiryDate: null
                }, { merge: true });

                showToast(`🎉 تم حفظ كود التنشيط ${actCode} للمشترك!`);
                emailInput.value = '';
                await renderOwnerLicenseManager();
            } catch (e) {
                console.error("Owner cannot generate/save license:", e);
                showToast("حدث خطأ أثناء حفظ الاشتراك.");
            } finally {
                addBtn.disabled = false;
                addBtn.textContent = "حفظ";
            }
        };
    }

    const deleteBtns = parent.querySelectorAll('.delete-lic-btn');
    deleteBtns.forEach(btn => {
        btn.onclick = async () => {
            const targetMail = btn.getAttribute('data-email');
            showCustomConfirm(`هل أنت متأكد من إلغاء اشتراك البريد ${targetMail}؟`, async () => {
                try {
                    await deleteDoc(doc(db, "licenses", targetMail));
                    showToast("تم إلغاء الاشتراك وحذف الكود بنجاح.");
                    await loadCloudData();
                } catch (e) {
                    console.error("Failed to delete license:", e);
                    showToast("حدث خطأ أثناء إلغاء الاشتراك.");
                }
            });
        };
    });
}

async function loadCloudData() {
    try {
        const globalRef = doc(db, "settings", "global");
        const docSnap = await getDoc(globalRef);
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            ownerEmail = data.ownerEmail;
            
            const curMail = currentUser?.email ? currentUser.email.toLowerCase().trim() : '';
            const ownMail = ownerEmail ? ownerEmail.toLowerCase().trim() : '';
            
            if (currentUser && curMail && ownMail && curMail === ownMail) {
                isOwner = true;
            } else {
                isOwner = false; // Spectator by default if settings already exist in the cloud!
            }
            
            // Pull boards from Firestore
            const boardsSnap = await getDocs(collection(db, "boards"));
            let cloudBoards = [];
            boardsSnap.forEach(d => { cloudBoards.push(d.data()); });
            
            // Pull notes from Firestore
            const notesSnap = await getDocs(collection(db, "notes"));
            let cloudNotes = [];
            notesSnap.forEach(d => { cloudNotes.push(d.data()); });
            
            // Pull trash from Firestore
            const trashSnap = await getDocs(collection(db, "trash"));
            let cloudTrash = [];
            trashSnap.forEach(d => { cloudTrash.push(d.data()); });
            
            // Preserve local-only board and its notes/trash
            const localBoards = boards.filter(b => b.id === 'local_user');
            const localNotes = notes.filter(n => n.boardId === 'local_user');
            const localTrash = trash.filter(t => t.boardId === 'local_user');

            if (isOwner && currentUser) {
                // Safeguard: If the cloud is completely empty of boards and notes but we have local data,
                // automatically push our local data to the cloud rather than wiping it!
                const uploadableNotes = notes.filter(n => n.boardId !== 'local_user');
                const uploadableBoards = boards.filter(b => b.id !== 'local_user');
                if (cloudNotes.length === 0 && cloudBoards.length === 0 && (uploadableNotes.length > 0 || uploadableBoards.length > 0)) {
                    showToast("جاري رفع نصوصك ولوحاتك المحلية سحابياً للمزامنة...");
                    await uploadAllToFirestore();
                } else {
                    // Pull cloud data into memory
                    const cleanedCloudBoards = cloudBoards.filter(b => b.id !== 'local_user');
                    const cleanedCloudNotes = cloudNotes.filter(n => n.boardId !== 'local_user');
                    const cleanedCloudTrash = cloudTrash.filter(t => t.boardId !== 'local_user');

                    boards = [...localBoards, ...cleanedCloudBoards];
                    notes = [...localNotes, ...cleanedCloudNotes];
                    trash = [...localTrash, ...cleanedCloudTrash];
                    
                    // Keep IndexedDB in sync with cloud
                    await saveData();
                }
            } else {
                // Spectator (either not logged in, or logged in as different user): pull cloud data only
                const cleanedCloudBoards = cloudBoards.filter(b => b.id !== 'local_user');
                const cleanedCloudNotes = cloudNotes.filter(n => n.boardId !== 'local_user');
                const cleanedCloudTrash = cloudTrash.filter(t => t.boardId !== 'local_user');

                if (localBoards.length === 0) {
                    localBoards.push({ id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true });
                }

                if (cleanedCloudBoards.length === 0) {
                    cleanedCloudBoards.push({ id: '1', name: 'الرئيسية', order: 0, isFree: true });
                }

                boards = [...localBoards, ...cleanedCloudBoards];
                notes = [...localNotes, ...cleanedCloudNotes];
                trash = [...localTrash, ...cleanedCloudTrash];

                await saveData();
            }
            
            // Map board names to rename 'عام' to 'الرئيسية'
            boards = boards.map(b => {
                if (b.id === '1' || b.name === 'عام') {
                    return { ...b, name: 'الرئيسية' };
                }
                return b;
            });

            // Ensure 'local_user' exists and is at order -999
            const hasLocalUser = boards.some(b => b.id === 'local_user');
            if (!hasLocalUser) {
                boards.unshift({ id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true });
            } else {
                boards = boards.map(b => b.id === 'local_user' ? { ...b, name: 'لوحة المستخدم', order: -999 } : b);
            }

            // Re-order and reset active board if needed
            boards = boards.sort((a,b) => a.order - b.order);
            if (!boards.find(b => b.id === activeBoardId)) {
                activeBoardId = boards[0]?.id || 'local_user';
            }
            
            await checkLicenseAndAccess();
            
            renderBoardsNav();
            renderBoardsList();
            renderNotes();
            updateCurrentBoardBtn();
            applyOwnershipUIRestrictions();
            updateSyncBadge();
        } else {
            // Document settings/global does NOT exist in the database!
            // If there is a currentUser currently logged in, let's establish them as the owner!
            if (currentUser && currentUser.email) {
                ownerEmail = currentUser.email;
                isOwner = true;
                isUserPremium = true;
                try {
                    await setDoc(globalRef, {
                        ownerEmail: currentUser.email,
                        ownerName: currentUser.displayName || '',
                        lastSync: Date.now()
                    });
                    showToast("تم إنشاء إعدادات المالك وتفعيل المزامنة بنجاح ☁️");
                    await uploadAllToFirestore();
                } catch (e) {
                    console.error("Failed to self-assign owner info: ", e);
                }
            } else {
                // No logged in user, default to local owner mode
                isOwner = true;
                isUserPremium = true;
                ownerEmail = null;
            }
            applyOwnershipUIRestrictions();
            updateSyncBadge();
        }
    } catch (err) {
        console.error("Failed to load cloud data: ", err);
    }
}

async function handleLogin() {
    try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        googleAccessToken = credential?.accessToken || null;
        currentUser = result.user;
        
        const globalRef = doc(db, "settings", "global");
        const docSnap = await getDoc(globalRef);
        
        if (!docSnap.exists()) {
            await setDoc(globalRef, {
                ownerEmail: currentUser.email,
                ownerName: currentUser.displayName || '',
                lastSync: Date.now()
            });
            ownerEmail = currentUser.email;
            isOwner = true;
            showToast("تم تسجيل ملكيتك وتفعيل المزامنة السحابية بنجاح!");
            await uploadAllToFirestore();
        } else {
            const data = docSnap.data();
            ownerEmail = data.ownerEmail;
            
            const curMail = currentUser?.email ? currentUser.email.toLowerCase().trim() : '';
            const ownMail = ownerEmail ? ownerEmail.toLowerCase().trim() : '';
            
            if (curMail && ownMail && curMail === ownMail) {
                isOwner = true;
                showToast("تم تسجيل الدخول بنجاح أيها المالك!");
            } else {
                isOwner = false;
                showToast("تسجيل ناجح كقارئ فقط!");
            }
        }
        
        if (isOwner && googleAccessToken) {
            try {
                googleDriveFileId = await findBackupFileOnDrive(googleAccessToken);
                if (googleDriveFileId) {
                    showToast("تم العثور على نسخة احتياطية من Drive ومزامنتها.");
                    if (boards.length === 0 || notes.length === 0) {
                        const backup = await downloadBackupFromDrive(googleAccessToken, googleDriveFileId);
                        if (backup && backup.boards) {
                            const localUserBoard = boards.find(b => b.id === 'local_user') || { id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true };
                            const localNotes = notes.filter(n => n.boardId === 'local_user');
                            const localTrash = trash.filter(t => t.boardId === 'local_user');
                            
                            const backupBoards = (backup.boards || []).filter(b => b.id !== 'local_user');
                            const backupNotes = (backup.notes || []).filter(n => n.boardId !== 'local_user');
                            const backupTrash = (backup.trash || []).filter(t => t.boardId !== 'local_user');

                            boards = [localUserBoard, ...backupBoards];
                            notes = [...localNotes, ...backupNotes];
                            trash = [...localTrash, ...backupTrash];
                            await saveData();
                            await uploadAllToFirestore();
                        }
                    }
                } else {
                    await uploadBackupToDrive(googleAccessToken, null);
                    showToast("تم إنشاء نسخة احتياطية أولى في غوغل درايف.");
                }
            } catch (err) {
                console.error("Google Drive connection failure: ", err);
            }
        }
        
        await loadCloudData();
        updateAuthUI();
        
    } catch (err) {
        console.error("Login call failed:", err);
        showToast("فشل تسجيل الدخول: " + err.message);
    }
}

async function handleLogout() {
    try {
        await signOut(auth);
        currentUser = null;
        googleAccessToken = null;
        googleDriveFileId = null;
        isOwner = false;
        ownerEmail = null;
        
        loadData();
        renderBoardsNav();
        renderBoardsList();
        renderNotes();
        updateCurrentBoardBtn();
        applyOwnershipUIRestrictions();
        updateAuthUI();
        updateSyncBadge();
        showToast("تم تسجيل الخروج. عدت إلى وضع التخزين المحلي.");
    } catch (err) {
        console.error("Logout failed:", err);
    }
}

function updateAuthUI() {
    const authSection = document.getElementById('auth-section');
    if (!authSection) return;
    
    if (currentUser) {
        const mailOwner = ownerEmail || '';
        const userMail = currentUser.email;
        const isUserOwner = isOwner;
        
        if (isUserOwner) {
            authSection.innerHTML = `
                <div class="auth-user-info">
                    <span>مرحباً، <span class="auth-user-email">${currentUser.email}</span></span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 5px; width: 100%;">
                    <button id="auth-logout-btn" class="auth-logout-btn" style="width: 100%;">تسجيل الخروج</button>
                </div>
            `;
        } else {
            authSection.innerHTML = `
                <div class="auth-user-info">
                    <span>مرحباً، <span class="auth-user-email">${currentUser.email}</span></span>
                    <a href="mailto:${mailOwner || 'alwaelai2000@gmail.com'}" style="display: inline-flex; align-items: center; justify-content: center; gap: 4px; margin-top: 4px; padding: 4px 8px; border-radius: 6px; background-color: #f0fdf4; color: #166534; text-decoration: none; font-size: 11px; font-weight: bold; border: 1px solid #bbf7d0; transition: all 0.2s; direction: ltr;" onmouseover="this.style.backgroundColor='#dcfce7'" onmouseout="this.style.backgroundColor='#f0fdf4'">
                        📧 للتواصل: ${mailOwner || 'alwaelai2000@gmail.com'}
                    </a>
                </div>
                <button id="auth-logout-btn" class="auth-logout-btn" style="margin-top:2px;">تسجيل الخروج</button>
            `;
        }
        
        const logoutBtn = document.getElementById('auth-logout-btn');
        if (logoutBtn) logoutBtn.onclick = handleLogout;
    } else {
        authSection.innerHTML = `
            <div class="auth-user-info" style="margin-bottom: 5px;">
                <span>قم بتسجيل الدخول للحفظ السحابي ومزامنة Google Drive.</span>
            </div>
            <button id="auth-login-btn" class="gsi-material-button">
                <div class="gsi-material-button-icon">
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style="display: block;">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                        <path fill="none" d="M0 0h48v48H0z"></path>
                    </svg>
                </div>
                <span class="gsi-material-button-contents">تسجيل الدخول عبر الايميل</span>
            </button>
        `;
        const loginBtn = document.getElementById('auth-login-btn');
        if (loginBtn) loginBtn.onclick = handleLogin;
    }
    renderOwnerLicenseManager();
}

// IndexedDB Storage Engine (Asynchronous Local Storage replacement)
const DB_NAME = 'app_notes_db';
const DB_VERSION = 1;
const STORE_NAME = 'app_store';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function getIDBValue(key) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }).catch(err => {
        console.error("IndexedDB get error:", err);
        return null;
    });
}

function setIDBValue(key, value) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }).catch(err => {
        console.error("IndexedDB put error:", err);
    });
}

// Populate Note Publishing Selector options dynamically
function populatePublishBoardSelect() {
    const select = document.getElementById('publish-board-select');
    if (!select) return;
    
    const previousValue = select.value;
    select.innerHTML = '';
    
    let targetBoards = [];
    if (isOwner) {
        targetBoards = [...boards];
    } else {
        // Visitors can only publish locally to 'لوحة المستخدم'
        targetBoards = boards.filter(b => b.id === 'local_user');
    }
    
    // Sort so 'local_user' or lowest order is first
    const sortedBoards = targetBoards.sort((a, b) => {
        if (a.id === 'local_user') return -1;
        if (b.id === 'local_user') return 1;
        return a.order - b.order;
    });
    
    sortedBoards.forEach(board => {
        const option = document.createElement('option');
        option.value = board.id;
        option.textContent = board.name;
        select.appendChild(option);
    });
    
    // Retain previous selection if valid, otherwise fallback to 'local_user'
    if (previousValue && targetBoards.some(b => b.id === previousValue)) {
        select.value = previousValue;
    } else {
        select.value = 'local_user';
    }
}

// State
let boards = [];
let notes = [];
let trash = [];
let activeBoardId = '1';
let inputText = '';
let searchQuery = '';
let sortOrder = 'timestamp-desc'; // timestamp-desc, timestamp-asc, content-asc
let isSidebarOpen = false;
let isBoardsExpanded = false;
let isExportImportExpanded = false;
let expandedNoteIds = new Set(); // For text expansion
let openMenuId = null; // For menu and highlight
let fontSize = 14; // Default font size in px
let modal = { type: 'NONE', data: null };
let toastMessage = '';

// Audio upload state
let selectedAudioFile = null;
let selectedAudioBase64 = null;
let selectedAudioName = '';

// Audio edit state
let editSelectedAudioFile = null;
let editSelectedAudioBase64 = null;
let editSelectedAudioName = '';
let editAudioDeleted = false;

// Language map for translation
const languageMap = {
    'Arabic': 'ar',
    'English': 'en',
    'French': 'fr',
    'Spanish': 'es',
    'German': 'de',
    'auto': 'auto'
};

// DOM Elements
const elements = {};

// Initialize DOM elements
function initElements() {
    elements.toast = document.getElementById('toast');
    elements.toastMessage = document.getElementById('toast-message');
    elements.sidebar = document.getElementById('sidebar');
    elements.sidebarOverlay = document.getElementById('sidebar-overlay');
    elements.boardsNav = document.getElementById('boards-nav');
    elements.boardsList = document.getElementById('boards-list');
    elements.notesList = document.getElementById('notes-list');
    elements.noteForm = document.getElementById('note-form');
    elements.noteInput = document.getElementById('note-input');
    elements.searchInput = document.getElementById('search-input');
    elements.currentBoardBtn = document.getElementById('current-board-btn');
    elements.boardModal = document.getElementById('board-modal');
    elements.boardForm = document.getElementById('board-form');
    elements.boardInput = document.getElementById('board-input');
    elements.deleteBoardModal = document.getElementById('delete-board-modal');
    elements.reorderModal = document.getElementById('reorder-modal');
    elements.trashModal = document.getElementById('trash-modal');
    elements.moveModal = document.getElementById('move-modal');
    elements.editNoteModal = document.getElementById('edit-note-modal');
    elements.translateModal = document.getElementById('translate-modal');
    elements.originalText = document.getElementById('original-text');
    elements.translatedText = document.getElementById('translated-text');
    elements.sourceLang = document.getElementById('source-lang');
    elements.targetLang = document.getElementById('target-lang');
    elements.importTextFile = document.getElementById('import-text-file');
}

// Load data from IndexedDB
async function loadData() {
    try {
        const savedBoards = await getIDBValue('app_boards');
        if (savedBoards) {
            boards = JSON.parse(savedBoards);
        } else {
            // First time load: only show 'لوحة المستخدم' and 'الرئيسية' (which replaces 'عام')
            boards = [
                { id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true },
                { id: '1', name: 'الرئيسية', order: 0, isFree: true }
            ];
        }

        const savedNotes = await getIDBValue('app_notes');
        notes = savedNotes ? JSON.parse(savedNotes) : [];

        const savedTrash = await getIDBValue('app_trash');
        trash = savedTrash ? JSON.parse(savedTrash) : [];
    } catch (e) {
        console.error('Failed to load data', e);
        boards = [
            { id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true },
            { id: '1', name: 'الرئيسية', order: 0, isFree: true }
        ];
        notes = [];
        trash = [];
    }

    // Ensure 'لوحة المستخدم' (id: 'local_user') always exists in the boards list and is first
    const hasLocalUser = boards.some(b => b.id === 'local_user');
    if (!hasLocalUser) {
        boards.unshift({ id: 'local_user', name: 'لوحة المستخدم', order: -999, isFree: true });
    } else {
        // Double check it's named correctly and order is correct
        boards = boards.map(b => b.id === 'local_user' ? { ...b, name: 'لوحة المستخدم', order: -999 } : b);
    }

    // Map board names to rename 'عام' to 'الرئيسية'
    boards = boards.map(b => {
        if (b.id === '1' || b.name === 'عام') {
            return { ...b, name: 'الرئيسية' };
        }
        return b;
    });

    // Ensure activeBoardId is valid
    if (!boards.find(b => b.id === activeBoardId)) {
        activeBoardId = boards[0]?.id || 'local_user';
    }
    
    // Populate the publish dropdown
    populatePublishBoardSelect();
}

// Save data to IndexedDB
async function saveData() {
    await setIDBValue('app_boards', JSON.stringify(boards));
    await setIDBValue('app_notes', JSON.stringify(notes));
    await setIDBValue('app_trash', JSON.stringify(trash));
    
    if (isOwner && currentUser) {
        // Automatically sync to Firestore
        uploadAllToFirestore().catch(err => {
            console.error("Firestore auto-sync error:", err);
        });
        
        // Automatically sync to Google Drive
        if (googleAccessToken) {
            uploadBackupToDrive(googleAccessToken, googleDriveFileId).catch(err => {
                console.error("Google Drive auto-backup error:", err);
            });
        }
    }
}

// Show toast
function showToast(message) {
    toastMessage = message;
    elements.toastMessage.textContent = message;
    elements.toast.classList.add('show');
    setTimeout(() => {
        elements.toast.classList.remove('show');
    }, 1000);
}

// Custom Dialog Handlers (Iframe & Sandbox Safe)
function showCustomConfirm(message, onConfirm, isDanger = true) {
    const modalEl = document.getElementById('custom-confirm-modal');
    const msgEl = document.getElementById('custom-confirm-message');
    const okBtn = document.getElementById('custom-confirm-ok');
    const cancelBtn = document.getElementById('custom-confirm-cancel');

    msgEl.textContent = message;
    
    if (isDanger) {
        okBtn.style.backgroundColor = '#dc2626';
        okBtn.textContent = 'تأكيد';
    } else {
        okBtn.style.backgroundColor = '#4b6382';
        okBtn.textContent = 'موافق';
    }
    
    cancelBtn.style.display = 'block';

    modalEl.classList.add('show');
    
    okBtn.onclick = () => {
        modalEl.classList.remove('show');
        if (onConfirm) onConfirm();
    };
    
    cancelBtn.onclick = () => {
        modalEl.classList.remove('show');
    };
}

function showCustomAlert(message) {
    const modalEl = document.getElementById('custom-confirm-modal');
    const msgEl = document.getElementById('custom-confirm-message');
    const okBtn = document.getElementById('custom-confirm-ok');
    const cancelBtn = document.getElementById('custom-confirm-cancel');

    msgEl.textContent = message;
    okBtn.style.backgroundColor = '#4b6382';
    okBtn.textContent = 'حسناً';
    cancelBtn.style.display = 'none';

    modalEl.classList.add('show');
    
    okBtn.onclick = () => {
        modalEl.classList.remove('show');
        cancelBtn.style.display = 'block';
    };
}

function showCustomPrompt(message, defaultValue, onSubmit) {
    const modalEl = document.getElementById('custom-prompt-modal');
    const msgEl = document.getElementById('custom-prompt-message');
    const inputEl = document.getElementById('custom-prompt-input');
    const okBtn = document.getElementById('custom-prompt-ok');
    const cancelBtn = document.getElementById('custom-prompt-cancel');

    msgEl.textContent = message;
    inputEl.value = defaultValue || '';
    modalEl.classList.add('show');
    
    setTimeout(() => { inputEl.focus(); }, 100);

    okBtn.onclick = () => {
        const val = inputEl.value.trim();
        modalEl.classList.remove('show');
        if (onSubmit) onSubmit(val);
    };

    cancelBtn.onclick = () => {
        modalEl.classList.remove('show');
    };
    
    inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            okBtn.click();
        } else if (e.key === 'Escape') {
            cancelBtn.click();
        }
    };
}

// Translation function
async function translateText(text, sourceLang, targetLang) {
    if (!text.trim()) return '';

    try {
        const sourceCode = languageMap[sourceLang] || sourceLang;
        const targetCode = languageMap[targetLang] || targetLang;

        // Split text into chunks to avoid URL length limits
        const chunks = splitTextIntoChunks(text, 1500); // 1500 chars per chunk
        let translatedText = '';

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const apiUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceCode}&tl=${targetCode}&dt=t&q=${encodeURIComponent(chunk)}`;

            const response = await fetch(apiUrl);
            if (!response.ok) throw new Error('Translation failed');

            const data = await response.json();
            if (data && data[0]) {
                for (let i = 0; i < data[0].length; i++) {
                    if (data[0][i] && data[0][i][0]) {
                        translatedText += data[0][i][0];
                    }
                }
            }
        }
        return translatedText;
    } catch (error) {
        console.error('Translation error:', error);
        return 'خطأ: لا يمكن الترجمة بدون إتصال أنترنت.';
    }
}

// Helper function to split text into chunks
function splitTextIntoChunks(text, maxLength) {
    const chunks = [];
    let currentChunk = '';

    // Split by paragraphs first
    const paragraphs = text.split(/\n\s*\n/);

    for (const paragraph of paragraphs) {
        if ((currentChunk + paragraph).length <= maxLength) {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = paragraph;
            } else {
                // Paragraph itself is too long, split by sentences
                const sentences = paragraph.split(/(?<=[.!?])\s+/);
                for (const sentence of sentences) {
                    if ((currentChunk + sentence).length <= maxLength) {
                        currentChunk += (currentChunk ? ' ' : '') + sentence;
                    } else {
                        if (currentChunk) {
                            chunks.push(currentChunk);
                        }
                        currentChunk = sentence;
                    }
                }
            }
        }
    }
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    return chunks;
}

// Render boards navigation
function renderBoardsNav() {
    const sortedBoards = [...boards].sort((a, b) => a.order - b.order);
    elements.boardsNav.innerHTML = '';

    sortedBoards.forEach(board => {
        const btn = document.createElement('button');
        btn.className = `board-btn ${board.id === activeBoardId ? 'active' : ''}`;
        
        const isPremiumBoard = !board.isFree && !isUserPremium && board.id !== 'local_user';
        btn.textContent = isPremiumBoard ? '🔒 ' + board.name : board.name;
        
        const count = notes.filter(n => n.boardId === board.id).length;
        if (count > 0) {
            const badge = document.createElement('span');
            badge.className = 'board-badge';
            badge.textContent = count;
            btn.appendChild(badge);
        }
        btn.onclick = () => {
            activeBoardId = board.id;
            renderBoardsNav();
            renderNotes();
            updateCurrentBoardBtn();
        };
        elements.boardsNav.appendChild(btn);
    });

    populatePublishBoardSelect();
}

// Update current board button
function updateCurrentBoardBtn() {
    const board = boards.find(b => b.id === activeBoardId);
    if (board) {
        elements.currentBoardBtn.textContent = board.name;
    } else {
        elements.currentBoardBtn.textContent = 'اللوحة الحالية';
    }
}

// Render boards list in sidebar
function renderBoardsList() {
    const sortedBoards = [...boards].sort((a, b) => a.order - b.order);
    elements.boardsList.innerHTML = '';

    sortedBoards.forEach(board => {
        const item = document.createElement('div');
        item.className = 'board-item';

        const name = document.createElement('span');
        name.className = 'board-name';
        
        const isPremiumBoard = !board.isFree && !isUserPremium && board.id !== 'local_user';
        name.textContent = isPremiumBoard ? '🔒 ' + board.name : board.name;

        const actions = document.createElement('div');
        actions.className = 'board-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'board-action edit';
        editBtn.innerHTML = '✏';
        editBtn.onclick = () => openModal('EDIT_BOARD_NAME', board);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'board-action delete';
        deleteBtn.innerHTML = '🗑';
        deleteBtn.onclick = () => openModal('DELETE_BOARD', board);

        const isFixedBoard = board.id === 'local_user' || board.id === '1';
        if (isOwner && !isFixedBoard) {
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
        }
        item.appendChild(name);
        if (isOwner && !isFixedBoard) {
            item.appendChild(actions);
        }
        elements.boardsList.appendChild(item);
    });
}

// Render notes
function renderNotes() {
    const currentBoard = boards.find(b => b.id === activeBoardId);
    const isLockedBoard = currentBoard && !currentBoard.isFree && !isUserPremium;

    if (isLockedBoard) {
        elements.notesList.innerHTML = '';
        
        const lockContainer = document.createElement('div');
        lockContainer.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px 16px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; margin-top: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.04); max-width: 450px; margin-left: auto; margin-right: auto; transition: all 0.3s;';
        
        lockContainer.innerHTML = `
            <div style="font-size: 32px; margin-bottom: 8px;">🔒</div>
            <h3 style="font-size: 16.5px; font-weight: bold; color: #1e293b; margin-bottom: 8px; font-family: 'Noto Sans Arabic', sans-serif;">محتوى متميز (النسخة الكاملة)</h3>
            <p style="font-size: 13px; color: #475569; line-height: 1.6; margin-bottom: 14px; text-align: center; direction: rtl; font-family: 'Noto Sans Arabic', sans-serif; padding: 0 5px;">
                هذا التبويب يحتوي على نصوص متميزة منتقاة تمثل سنوات من القراءة والبحث العلمي والأكاديمي والتحقيق الدقيق. لمواصلة القراءة والاطلاع والبحث، يرجى تفعيل النسخة الكاملة أو الاشتراك بحساب متميز.
            </p>
        `;
        
        if (!currentUser) {
            lockContainer.innerHTML += `
                <div style="width: 100%; border-top: 1px solid #f1f5f9; padding-top: 12px;">
                    <p style="font-size: 12px; color: #64748b; margin-bottom: 12px; font-weight: 500;">
                        سجل دخولك  لتبدأ فترة تجريبية مجانية كاملة لمدة محدودة
                    </p>
                    <button id="lock-login-btn" class="primary-btn" style="width: 100%; padding: 10px; font-size: 13.5px; font-weight: bold; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                        🔑 تسجيل الدخول بالبريد الإلكتروني
                    </button>
                </div>
            `;
            elements.notesList.appendChild(lockContainer);
            
            const btn = document.getElementById('lock-login-btn');
            if (btn) {
                btn.onclick = () => {
                    handleLogin();
                };
            }
        } else {
            lockContainer.innerHTML += `
                <div style="width: 100%; border-top: 1px solid #f1f5f9; padding-top: 12px;">
                    <p style="font-size: 12.5px; color: #475569; margin-bottom: 10px; line-height: 1.4;">
                        الحساب الحالي: <span style="font-weight: bold; color: #0284c7;">${currentUser.email}</span>
                        <br/>
                        <span style="color: #ef4444; font-weight: bold; display: inline-block; margin-top: 4px;">🚫 انتهت الفترة التجريبية المجانية للنسخة الكاملة</span>
                    </p>
                    <div style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
                        <input id="activation-code" type="text" placeholder="أدخل كود التفعيل المخصص لبريدك الإلكتروني..." 
                               style="width: 100%; padding: 10px; border: 1.5px solid #cbd5e1; border-radius: 8px; text-align: center; font-size: 13.5px; font-weight: bold; letter-spacing: 1px; outline: none; transition: border-color 0.2s;"
                               onfocus="this.style.borderColor='#10b981'" onblur="this.style.borderColor='#cbd5e1'">
                        <button id="activate-now-btn" class="primary-btn" style="width: 100%; padding: 10px; font-size: 13.5px; font-weight: bold; border-radius: 8px; background-color: #10b981; border: none; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: opacity 0.2s;">
                            🚀 تفعيل النسخة الكاملة الآن
                        </button>
                    </div>
                    <p style="font-size: 11px; color: #94a3b8; margin-top: 8px; direction: rtl; line-height: 1.3;">
                        * يرجى إرسال بريدك الإلكتروني للمالك للحصول على كود التنشيط الخاص بك حصراً.
                    </p>
                </div>
            `;
            elements.notesList.appendChild(lockContainer);
            
            const btn = document.getElementById('activate-now-btn');
            if (btn) {
                btn.onclick = async () => {
                    const codeVal = document.getElementById('activation-code').value.trim();
                    if (!codeVal) {
                        showToast("يرجى إدخال كود التفعيل");
                        return;
                    }
                    btn.disabled = true;
                    btn.textContent = "جاري الاتصال والتحقق...";
                    
                    try {
                        const normEmail = currentUser.email.toLowerCase().trim();
                        const licRef = doc(db, "licenses", normEmail);
                        const licDoc = await getDoc(licRef);
                        
                        if (licDoc.exists()) {
                            const licData = licDoc.data();
                            if (licData.activationCode && licData.activationCode.trim() === codeVal) {
                                await setDoc(licRef, {
                                    ...licData,
                                    activated: true,
                                    activatedAt: Date.now()
                                });
                                showToast("🎉 تم التفعيل بنجاح! شكراً لدعمك وثقتك بالعمل.");
                                await loadCloudData();
                            } else {
                                showToast("❌ كود التفعيل غير صحيح أو غير مرتبط هذا الإيميل.");
                            }
                        } else {
                            showToast("❌ لم يتم العثور على قاعدة بيانات مسجلة لبريدك. يرجى التواصل مع المالك.");
                        }
                    } catch (err) {
                        console.error("Activation path exception: ", err);
                        showToast("حدث خطأ أثناء تفعيل حسابك سحابياً.");
                    } finally {
                        btn.disabled = false;
                        btn.textContent = "🚀 تفعيل النسخة الكاملة الآن";
                    }
                };
            }
        }
        return; // HALT notes render
    }

    let filteredNotes = notes
        .filter(note => note.boardId === activeBoardId)
        .filter(note => note.content.toLowerCase().includes(searchQuery.toLowerCase()));

    // Sort based on sortOrder
    if (sortOrder === 'timestamp-desc') {
        filteredNotes = filteredNotes.sort((a, b) => b.timestamp - a.timestamp);
    } else if (sortOrder === 'timestamp-asc') {
        filteredNotes = filteredNotes.sort((a, b) => a.timestamp - b.timestamp);
    } else if (sortOrder === 'content-asc') {
        filteredNotes = filteredNotes.sort((a, b) => a.content.localeCompare(b.content));
    }

    elements.notesList.innerHTML = '';

    if (filteredNotes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-notes';
        empty.textContent = 'لا توجد ملاحظات في هذه اللوحة';
        elements.notesList.appendChild(empty);
        return;
    }

    filteredNotes.forEach(note => {
        const item = document.createElement('div');
        item.id = `note-${note.id}`;
        const hasAudio = !!(note.audioData || note.audioDriveId);
        item.className = `note-item ${expandedNoteIds.has(note.id) ? 'active' : ''} ${note.id === openMenuId ? 'menu-open' : ''} ${hasAudio ? 'has-audio' : ''}`;

        const content = document.createElement('div');
        content.className = 'note-content';

        const text = document.createElement('p');
        text.className = 'note-text';
        text.textContent = note.content;
        // Set text direction
        const isArabic = /\p{Script=Arabic}/u.test(note.content);
        text.dir = isArabic ? 'rtl' : 'ltr';

        const meta = document.createElement('div');
        meta.className = 'note-meta';

        const date = document.createElement('span');
        date.className = 'note-date';
        const noteDateObj = new Date(note.timestamp);
        const dayStr = String(noteDateObj.getDate()).padStart(2, '0');
        const monthStr = String(noteDateObj.getMonth() + 1).padStart(2, '0');
        const yearStr = noteDateObj.getFullYear();
        let hours = noteDateObj.getHours();
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12; // the hour '0' should be '12'
        const hoursStr = String(hours).padStart(2, '0');
        const minutesStr = String(noteDateObj.getMinutes()).padStart(2, '0');
        date.textContent = `${dayStr}/${monthStr}/${yearStr} ${hoursStr}:${minutesStr} ${ampm}`;

        meta.appendChild(date);
        content.appendChild(text);
        content.appendChild(meta);

        // Render audio player if note has an audio attachment
        if (note.audioData || note.audioDriveId) {
            const audioContainer = document.createElement('div');
            audioContainer.className = 'note-audio-container';
            // Stop propagation to prevent note expansion toggle
            audioContainer.onclick = (e) => {
                e.stopPropagation();
            };

            const audioInfo = document.createElement('div');
            audioInfo.className = 'note-audio-info';

            const audioIconObj = document.createElement('span');
            audioIconObj.className = 'note-audio-icon';
            audioIconObj.textContent = '🎙️';

            const audioTitleObj = document.createElement('span');
            audioTitleObj.className = 'note-audio-title';
            audioTitleObj.textContent = note.audioName || 'ملف صوتي';

            audioInfo.appendChild(audioIconObj);
            audioInfo.appendChild(audioTitleObj);

            const audioPlayer = document.createElement('audio');
            audioPlayer.controls = true;
            audioPlayer.className = 'note-audio-player';
            audioPlayer.preload = 'metadata';
            
            if (note.audioData) {
                audioPlayer.src = note.audioData;
            } else if (note.audioDriveId) {
                audioPlayer.src = `https://docs.google.com/uc?export=download&id=${note.audioDriveId}`;
            }

            audioContainer.appendChild(audioInfo);
            audioContainer.appendChild(audioPlayer);
            content.appendChild(audioContainer);
        }

        const actions = document.createElement('div');
        actions.className = 'note-actions';

        const menuBtn = document.createElement('button');
        menuBtn.className = 'note-action menu-btn';
        menuBtn.innerHTML = '⁝';
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            toggleNoteMenu(note.id, actions);
        };

        const menu = document.createElement('div');
        menu.className = 'note-menu';
        menu.id = `menu-${note.id}`;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'menu-item';
        copyBtn.innerHTML = '🧮';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(note.content);
            showToast('تم نسخ النص');
            hideNoteMenu(note.id);
        };

        const editBtn = document.createElement('button');
        editBtn.className = 'menu-item';
        editBtn.innerHTML = '✏️';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            openModal('EDIT_NOTE', note);
            openMenuId = note.id;
            renderNotes();
        };

        const moveBtn = document.createElement('button');
        moveBtn.className = 'menu-item';
        moveBtn.innerHTML = '📩';
        moveBtn.onclick = (e) => {
            e.stopPropagation();
            openModal('MOVE_TO', note);
            hideNoteMenu(note.id);
        };

        const translateBtn = document.createElement('button');
        translateBtn.className = 'menu-item';
        translateBtn.innerHTML = '🌐';
        translateBtn.onclick = (e) => {
            e.stopPropagation();
            openModal('TRANSLATE', note);
            openMenuId = note.id;
            renderNotes();
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'menu-item delete';
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            showCustomConfirm('هل أنت متأكد من حذف هذه الملاحظة؟', () => {
                deleteNote(note);
            });
            hideNoteMenu(note.id);
        };

        const canModify = isOwner || note.boardId === 'local_user';
        const canMove = isOwner;

        menu.appendChild(copyBtn);
        if (canModify) {
            menu.appendChild(editBtn);
        }
        if (canMove) {
            menu.appendChild(moveBtn);
        }
        menu.appendChild(translateBtn);
        if (canModify) {
            menu.appendChild(deleteBtn);
        }

        if (note.id === openMenuId) {
            menu.classList.add('show');
        }

        actions.appendChild(menuBtn);
        actions.appendChild(menu);

        item.appendChild(content);
        item.appendChild(actions);

        item.onclick = () => {
            if (expandedNoteIds.has(note.id)) {
                expandedNoteIds.delete(note.id);
            } else {
                expandedNoteIds.add(note.id);
            }
            renderNotes();
        };

        elements.notesList.appendChild(item);
    });
}

// Modal functions
function openModal(type, data = null) {
    modal = { type, data };
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('show'));
    document.body.style.overflow = 'hidden'; // Prevent background scroll
    switch (type) {
        case 'ADD_BOARD':
        case 'EDIT_BOARD_NAME':
            elements.boardModal.classList.add('show');
            document.getElementById('board-modal-title').textContent =
                type === 'ADD_BOARD' ? 'إضافة لوحة جديدة' : 'تعديل اسم اللوحة';
            elements.boardInput.value = data ? data.name : '';
            const freeChkbx = document.getElementById('board-free-checkbox');
            if (freeChkbx) {
                freeChkbx.checked = data ? !!data.isFree : false;
            }
            break;
        case 'DELETE_BOARD':
            elements.deleteBoardModal.classList.add('show');
            break;
        case 'REORDER':
            renderReorderModal();
            elements.reorderModal.classList.add('show');
            break;
        case 'TRASH':
            renderTrashModal();
            elements.trashModal.classList.add('show');
            break;
        case 'MOVE_TO':
            renderMoveModal(data);
            elements.moveModal.classList.add('show');
            break;
        case 'EDIT_NOTE':
            elements.editNoteModal.classList.add('show', 'top-modal');
            document.getElementById('edit-note-textarea').value = data.content;
            // Set text direction
            const isArabic = /\p{Script=Arabic}/u.test(data.content);
            document.getElementById('edit-note-textarea').dir = isArabic ? 'rtl' : 'ltr';
            
            // Initialize edit audio state
            editSelectedAudioFile = null;
            editSelectedAudioBase64 = null;
            editSelectedAudioName = '';
            editAudioDeleted = false;
            
            const editAudioInput = document.getElementById('edit-audio-file-input');
            if (editAudioInput) editAudioInput.value = '';
            
            const editAudioStatus = document.getElementById('edit-audio-status');
            const editAudioNameEl = document.getElementById('edit-audio-name');
            const editMicLabel = document.getElementById('edit-mic-label');
            
            if (data.audioName) {
                if (editAudioStatus) editAudioStatus.style.display = 'flex';
                if (editAudioNameEl) editAudioNameEl.textContent = data.audioName;
                if (editMicLabel) editMicLabel.textContent = 'استبدال الملف الصوتي الحالي';
            } else {
                if (editAudioStatus) editAudioStatus.style.display = 'none';
                if (editMicLabel) editMicLabel.textContent = 'إضافة ملف صوتي';
            }

            // Keep the note expanded during editing
            expandedNoteIds.add(data.id);
            renderNotes();
            break;
        case 'TRANSLATE':
            elements.translateModal.classList.add('show', 'top-modal');
            elements.originalText.value = data.content;
            elements.translatedText.value = '';
            // Trigger translation
            elements.originalText.dispatchEvent(new Event('input'));
            break;
    }
}

function closeModal() {
    modal = { type: 'NONE', data: null };
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('show', 'top-modal'));
    document.body.style.overflow = ''; // Restore scroll
}

// Specific modal renders
function renderReorderModal() {
    const list = document.getElementById('reorder-list');
    list.innerHTML = '';
    const sortedBoards = [...boards].sort((a, b) => a.order - b.order);

    sortedBoards.forEach((board, index) => {
        const item = document.createElement('div');
        item.className = 'reorder-item';

        const name = document.createElement('span');
        name.className = 'reorder-name';
        name.textContent = board.name;

        const actions = document.createElement('div');
        actions.className = 'reorder-actions';

        const upBtn = document.createElement('button');
        upBtn.className = 'reorder-btn';
        upBtn.innerHTML = '↑';
        upBtn.disabled = index === 0;
        upBtn.onclick = () => reorderBoard(board.id, -1);

        const downBtn = document.createElement('button');
        downBtn.className = 'reorder-btn';
        downBtn.innerHTML = '↓';
        downBtn.disabled = index === sortedBoards.length - 1;
        downBtn.onclick = () => reorderBoard(board.id, 1);

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        item.appendChild(name);
        item.appendChild(actions);
        list.appendChild(item);
    });
}

function renderTrashModal() {
    const list = document.getElementById('trash-list');
    list.innerHTML = '';

    if (trash.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #6b7280; padding: 2rem;">سلة المحذوفات فارغة</p>';
        return;
    }

    trash.forEach(item => {
        const trashItem = document.createElement('div');
        trashItem.className = 'trash-item';

        const text = document.createElement('p');
        text.className = 'trash-text';
        text.textContent = item.content;

        const meta = document.createElement('div');
        meta.className = 'trash-meta';

        const board = document.createElement('span');
        board.textContent = `من: ${item.originalBoardName}`;

        const restore = document.createElement('button');
        restore.className = 'restore-btn';
        restore.textContent = 'استعادة هنا';
        restore.onclick = () => restoreNote(item);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = 'حذف';
        deleteBtn.onclick = () => {
            showCustomConfirm('سيتم حذف هذا النص نهائيا', () => {
                trash = trash.filter(t => t.id !== item.id);
                saveData();
                renderTrashModal();
                showToast('تم حذف النص نهائيا');
            });
        };

        meta.appendChild(board);
        if (isOwner) {
            meta.appendChild(restore);
            meta.appendChild(deleteBtn);
        }
        trashItem.appendChild(text);
        trashItem.appendChild(meta);
        list.appendChild(trashItem);
    });
}

function renderMoveModal(note) {
    const options = document.getElementById('move-options');
    options.innerHTML = '';

    boards.filter(b => b.id !== note.boardId).forEach(board => {
        const option = document.createElement('button');
        option.className = 'move-option';
        option.textContent = board.name;
        option.onclick = () => moveNote(note, board.id);
        options.appendChild(option);
    });
}

// Helper functions for duplicate text detection (checking same or close texts)
function normalizeTextForComparison(str) {
    if (!str) return '';
    let cleaned = str.toLowerCase();
    // Remove Arabic diacritics/vocalizations (Harakat)
    cleaned = cleaned.replace(/[\u064B-\u0652\u0670]/g, '');
    // Remove Arabic tatweel (kashida)
    cleaned = cleaned.replace(/ـ/g, '');
    // Normalize similar looking letters
    cleaned = cleaned.replace(/[أإآ]/g, 'ا');
    cleaned = cleaned.replace(/ة/g, 'ه');
    cleaned = cleaned.replace(/ى/g, 'ي');
    // Remove punctuation, extra symbols, dots, etc.
    cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'،؛؟\\|]/g, '');
    // Strip all whitespaces out for density comparison
    cleaned = cleaned.replace(/\s+/g, '').trim();
    return cleaned;
}

function getLevenshteinDistance(a, b) {
    const tmp = [];
    let i, j;
    for (i = 0; i <= a.length; i++) {
        tmp[i] = [i];
    }
    for (j = 0; j <= b.length; j++) {
        tmp[0][j] = j;
    }
    for (i = 1; i <= a.length; i++) {
        for (j = 1; j <= b.length; j++) {
            tmp[i][j] = Math.min(
                tmp[i - 1][j] + 1,
                tmp[i][j - 1] + 1,
                tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return tmp[a.length][b.length];
}

function areTextsClose(str1, str2) {
    const s1 = str1.trim();
    const s2 = str2.trim();
    if (s1 === s2) return true;
    
    const norm1 = normalizeTextForComparison(s1);
    const norm2 = normalizeTextForComparison(s2);
    
    // If they normalize to the same thing, they are close
    if (norm1 === norm2) return true;
    
    // If one is too short, only exact/direct normalized match counts
    if (norm1.length < 6 || norm2.length < 6) {
        return norm1 === norm2;
    }
    
    // Calculate Levenshtein distance on normalized text to allow minor differences
    const distance = getLevenshteinDistance(norm1, norm2);
    
    // Allow small edit distance (up to 2 character changes, or 10% of length, whichever is smaller)
    const threshold = Math.max(1, Math.floor(Math.min(norm1.length, norm2.length) * 0.1));
    return distance <= threshold;
}

// Actions
async function handleSaveNote() {
    if (!inputText.trim()) return;

    // Check for exact or close duplicate across all notes
    const matchedNote = notes.find(n => areTextsClose(n.content, inputText));
    if (matchedNote) {
        // Change active board if needed
        if (activeBoardId !== matchedNote.boardId) {
            activeBoardId = matchedNote.boardId;
            renderBoardsNav();
            updateCurrentBoardBtn();
        }
        
        // Expand the matched note
        expandedNoteIds.add(matchedNote.id);
        renderNotes();

        // Clear input field
        inputText = '';
        elements.noteInput.value = '';
        elements.noteInput.style.height = 'auto';

        showToast("⚠️ النص موجود فعلاً!");

        // Scroll to the note
        setTimeout(() => {
            const noteEl = document.getElementById('note-' + matchedNote.id);
            if (noteEl) {
                noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                noteEl.classList.add('note-highlight');
                setTimeout(() => {
                    noteEl.classList.remove('note-highlight');
                }, 3000);
            }
        }, 120);
        return;
    }

    const targetBoardId = document.getElementById('publish-board-select')?.value || activeBoardId;

    const newNote = {
        id: crypto.randomUUID(),
        boardId: targetBoardId,
        content: inputText,
        timestamp: Date.now()
    };

    // Handle audio file upload if present
    if (selectedAudioFile) {
        if (targetBoardId !== 'local_user') {
            // Owner board -> Google Drive
            if (googleAccessToken) {
                showToast("جاري رفع الملف الصوتي إلى Google Drive... 🎙️");
                try {
                    const fileId = await uploadAudioToDrive(googleAccessToken, selectedAudioFile);
                    newNote.audioDriveId = fileId;
                    newNote.audioName = selectedAudioName;
                } catch (driveErr) {
                    console.error("Drive upload failed:", driveErr);
                    showToast("❌ فشل رفع الملف الصوتي إلى Google Drive.");
                    return; // block note save
                }
            } else {
                showToast("⚠️ للرفع إلى Google Drive في هذه اللوحة، يرجى تسجيل الدخول أولاً.");
                return; // block note save
            }
        } else {
            // User board -> Local IndexedDB
            newNote.audioData = selectedAudioBase64;
            newNote.audioName = selectedAudioName;
        }
    }

    notes = [newNote, ...notes];
    inputText = '';
    elements.noteInput.value = '';
    elements.noteInput.style.height = 'auto'; // Reset height

    // Clear audio upload state and reset UI
    selectedAudioFile = null;
    selectedAudioBase64 = null;
    selectedAudioName = '';
    const audioFileInput = document.getElementById('audio-file-input');
    if (audioFileInput) audioFileInput.value = '';
    const selectedAudioContainer = document.getElementById('selected-audio-container');
    if (selectedAudioContainer) selectedAudioContainer.style.display = 'none';

    saveData();
    firestoreWriteNote(newNote);
    
    // Switch to target board immediately on save
    activeBoardId = targetBoardId;
    renderNotes();
    renderBoardsNav();
    updateCurrentBoardBtn();
    showToast('تم الحفظ بنجاح');
}

function deleteNote(note) {
    const trashItem = {
        ...note,
        deletedAt: Date.now(),
        originalBoardName: boards.find(b => b.id === note.boardId)?.name || 'Unknown'
    };
    trash = [trashItem, ...trash];
    notes = notes.filter(n => n.id !== note.id);
    saveData();
    firestoreDeleteNote(note.id);
    firestoreWriteTrash(trashItem);
    renderNotes();
    renderBoardsNav();
    showToast('نقلت للمحذوفات');
}

function restoreNote(item) {
    const restoredNote = {
        id: item.id,
        boardId: activeBoardId,
        content: item.content,
        timestamp: item.timestamp
    };
    notes = [restoredNote, ...notes];
    trash = trash.filter(t => t.id !== item.id);
    saveData();
    firestoreDeleteTrash(item.id);
    firestoreWriteNote(restoredNote);
    renderTrashModal();
    renderNotes();
    renderBoardsNav();
    showToast('تمت الاستعادة');
}

function moveNote(note, newBoardId) {
    const updatedNote = { ...note, boardId: newBoardId };
    notes = notes.map(n => n.id === note.id ? updatedNote : n);
    saveData();
    firestoreWriteNote(updatedNote);
    renderNotes();
    renderBoardsNav();
    closeModal();
    showToast(`نقلت إلى ${boards.find(b => b.id === newBoardId)?.name}`);
}

function reorderBoard(boardId, direction) {
    const board = boards.find(b => b.id === boardId);
    if (!board) return;

    const sortedBoards = [...boards].sort((a, b) => a.order - b.order);
    const index = sortedBoards.findIndex(b => b.id === boardId);
    const targetIndex = index + direction;

    if (targetIndex < 0 || targetIndex >= sortedBoards.length) return;

    const temp = sortedBoards[index].order;
    sortedBoards[index].order = sortedBoards[targetIndex].order;
    sortedBoards[targetIndex].order = temp;

    boards = sortedBoards;
    saveData();
    boards.forEach(b => firestoreWriteBoard(b));
    renderReorderModal();
    renderBoardsNav();
}

function handleBoardSubmit(e) {
    e.preventDefault();
    const name = elements.boardInput.value.trim();
    if (!name) return;

    const freeChkbx = document.getElementById('board-free-checkbox');
    const isFree = freeChkbx ? !!freeChkbx.checked : false;

    if (modal.type === 'ADD_BOARD') {
        const newBoard = {
            id: crypto.randomUUID(),
            name,
            isFree,
            order: boards.length
        };
        boards = [...boards, newBoard];
        activeBoardId = newBoard.id;
        showToast('تمت الإضافة');
        firestoreWriteBoard(newBoard);
    } else if (modal.type === 'EDIT_BOARD_NAME') {
        const updatedBoard = { ...modal.data, name, isFree };
        boards = boards.map(b => b.id === modal.data.id ? updatedBoard : b);
        showToast('تم التعديل');
        firestoreWriteBoard(updatedBoard);
    }

    saveData();
    renderBoardsNav();
    updateCurrentBoardBtn();
    renderBoardsList();
    closeModal();
}

function handleBoardDelete() {
    const board = boards.find(b => b.id === modal.data.id);
    if (!board) return;

    const boardNotes = notes.filter(n => n.boardId === board.id);
    const trashNotes = boardNotes.map(n => ({
        ...n,
        deletedAt: Date.now(),
        originalBoardName: board.name
    }));

    trash = [...trash, ...trashNotes];
    notes = notes.filter(n => n.boardId !== board.id);
    boards = boards.filter(b => b.id !== board.id);

    if (activeBoardId === board.id) {
        activeBoardId = boards[0]?.id || '';
    }

    saveData();
    firestoreDeleteBoard(board.id);
    trashNotes.forEach(tn => {
        firestoreDeleteNote(tn.id);
        firestoreWriteTrash(tn);
    });
    renderBoardsNav();
    updateCurrentBoardBtn();
    renderBoardsList();
    renderNotes();
    closeModal();
    showToast('تم حذف اللوحة');
}

async function handleEditSave() {
    const content = document.getElementById('edit-note-textarea').value;
    const noteId = modal.data.id;
    const originalNote = modal.data;
    const updatedNote = { ...originalNote, content };

    // Apply audio modifications if deletion was selected
    if (editAudioDeleted) {
        delete updatedNote.audioData;
        delete updatedNote.audioDriveId;
        delete updatedNote.audioName;
    }

    // Apply audio modifications if a new file was uploaded
    if (editSelectedAudioFile) {
        if (updatedNote.boardId !== 'local_user') {
            // Owner board -> Google Drive
            if (googleAccessToken) {
                showToast("جاري رفع الملف الصوتي الجديد إلى Google Drive... 🎙️");
                try {
                    const fileId = await uploadAudioToDrive(googleAccessToken, editSelectedAudioFile);
                    updatedNote.audioDriveId = fileId;
                    updatedNote.audioName = editSelectedAudioName;
                    delete updatedNote.audioData;
                } catch (driveErr) {
                    console.error("Drive upload failed during edit:", driveErr);
                    showToast("❌ فشل رفع الملف الصوتي إلى Google Drive.");
                    return; // block note save
                }
            } else {
                showToast("⚠️ للرفع إلى Google Drive في هذه اللوحة، يرجى تسجيل الدخول أولاً.");
                return; // block note save
            }
        } else {
            // User board -> Local IndexedDB
            updatedNote.audioData = editSelectedAudioBase64;
            updatedNote.audioName = editSelectedAudioName;
            delete updatedNote.audioDriveId;
        }
    }

    notes = notes.map(n => n.id === noteId ? updatedNote : n);
    expandedNoteIds.add(noteId);
    saveData();
    firestoreWriteNote(updatedNote);
    renderNotes();
    closeModal();
    if (openMenuId === noteId) {
        setTimeout(() => {
            openMenuId = null;
            expandedNoteIds.delete(noteId);
            renderNotes();
        }, 5000);
    }
    showToast('تم التحديث');
}

async function handleExport() {
    const data = JSON.stringify({ boards, notes, trash }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const filename = `manager-backup-${new Date().toISOString().slice(0,10)}.json`;

    const downloadFallback = () => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('تم التصدير (المجلد الافتراضي)');
    };

    if ('showSaveFilePicker' in window) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'JSON Backup File',
                    accept: { 'application/json': ['.json'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            showToast('تم حفظ النسخة بنجاح');
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn("showSaveFilePicker failed, using fallback", err);
                downloadFallback();
            }
        }
    } else {
        showCustomAlert('متصفحك لا يدعم اختيار مكان الحفظ المباشر، سيتم التنزيل في المجلد الافتراضي.');
        downloadFallback();
    }
}

async function handleExportBoard() {
    const activeBoard = boards.find(b => b.id === activeBoardId);
    if (!activeBoard) return;

    const boardNotes = notes.filter(n => n.boardId === activeBoardId);
    const data = JSON.stringify({ board: activeBoard, notes: boardNotes }, null, 2);
    const filename = `${activeBoard.name}-manager-backup-.json`;

    const downloadFallback = () => {
        const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('تم تصدير اللوحة');
    };

    if ('showSaveFilePicker' in window) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'Board Backup File',
                    accept: { 'application/json': ['.json'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(new Blob([data], { type: 'application/json' }));
            await writable.close();
            showToast('تم حفظ اللوحة بنجاح');
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn("showSaveFilePicker failed, using fallback", err);
                downloadFallback();
            }
        }
    } else {
        downloadFallback();
    }
}

function handleImportBoard(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileInput = e.target;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (data.board && data.notes) {
                const newBoardId = crypto.randomUUID();
                const importedBoard = { ...data.board, id: newBoardId };
                const importedNotes = data.notes.map(n => ({ ...n, boardId: newBoardId }));

                boards.push(importedBoard);
                notes.push(...importedNotes);

                activeBoardId = newBoardId;
                saveData();
                renderBoardsNav();
                renderBoardsList();
                renderNotes();
                showToast('تم استيراد اللوحة بنجاح');
            } else {
                showCustomAlert('ملف غير صالح لاستيراد لوحة.');
            }
        } catch (err) {
            showCustomAlert('فشل الاستيراد، ملف غير صالح.');
        } finally {
            fileInput.value = '';
        }
    };
    reader.readAsText(file);
}

function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileInput = e.target;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            let importedBoards = data.boards;
            let importedNotes = data.notes;
            if (data.board) {
                // Handle old format with single board
                importedBoards = [data.board];
                importedNotes = data.notes;
            }
            if (importedBoards && importedNotes) {
                showCustomConfirm('هل أنت متأكد؟ سيتم استبدال البيانات الحالية بالبيانات المستوردة.', () => {
                    boards = importedBoards;
                    notes = importedNotes;
                    trash = data.trash || [];
                    saveData();
                    renderBoardsNav();
                    renderBoardsList();
                    renderNotes();
                    showToast('تم الاستيراد بنجاح');
                });
            } else {
                showCustomAlert('ملف غير صالح، يجب أن يحتوي على boards و notes.');
            }
        } catch (err) {
            showCustomAlert('فشل الاستيراد، ملف غير صالح.');
        } finally {
            fileInput.value = '';
        }
    };
    reader.readAsText(file);
}

function handleImportText(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileInput = e.target;

    const reader = new FileReader();
    reader.onload = (ev) => {
        const text = ev.target.result;
        showCustomPrompt('اسم اللوحة:', '', (boardName) => {
            if (!boardName) {
                fileInput.value = '';
                return;
            }

            let board = boards.find(b => b.name === boardName);
            if (!board) {
                board = {
                    id: crypto.randomUUID(),
                    name: boardName,
                    order: boards.length
                };
                boards.push(board);
            }

            const notesText = text.split(/-{7,}/);
            const parsedTexts = notesText.map(content => content.trim()).filter(Boolean);
            const uniqueParsedTexts = [...new Set(parsedTexts)];

            const existingContents = notes.filter(n => n.boardId === board.id).map(n => n.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
            const normalizedParsedTexts = uniqueParsedTexts.map(text => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
            const allExist = normalizedParsedTexts.every(text => existingContents.includes(text));

            if (allExist) {
                showToast('النصوص موجودة فعلا');
                fileInput.value = '';
                return;
            }

            const newTexts = normalizedParsedTexts.filter(text => !existingContents.includes(text));
            const newNotes = newTexts.map((content, index) => ({
                id: crypto.randomUUID(),
                boardId: board.id,
                content,
                timestamp: Date.now() + (newTexts.length - 1 - index) * 1000
            }));

            notes.push(...newNotes);
            activeBoardId = board.id;
            saveData();
            renderBoardsNav();
            renderBoardsList();
            renderNotes();
            showToast('تم استيراد النص بنجاح');
            fileInput.value = '';
        });
    };
    reader.readAsText(file);
}

// Event listeners
function initEventListeners() {
    // Sidebar
    document.getElementById('open-sidebar').onclick = () => {
        isSidebarOpen = true;
        elements.sidebar.classList.add('show');
        elements.sidebarOverlay.classList.add('show');
        document.body.style.overflow = 'hidden'; // Prevent background scroll
    };

    document.getElementById('close-sidebar').onclick = () => {
        isSidebarOpen = false;
        elements.sidebar.classList.remove('show');
        elements.sidebarOverlay.classList.remove('show');
        document.body.style.overflow = ''; // Restore scroll
    };

    elements.sidebarOverlay.onclick = () => {
        isSidebarOpen = false;
        elements.sidebar.classList.remove('show');
        elements.sidebarOverlay.classList.remove('show');
        document.body.style.overflow = ''; // Restore scroll
    };

    // Boards toggle
    document.getElementById('boards-toggle').onclick = () => {
        isBoardsExpanded = !isBoardsExpanded;
        document.getElementById('boards-chevron').textContent = isBoardsExpanded ? '▼' : '▶';
        document.getElementById('boards-section-content').style.display = isBoardsExpanded ? 'block' : 'none';
    };

    // Export & Import toggle
    document.getElementById('export-import-toggle').onclick = () => {
        isExportImportExpanded = !isExportImportExpanded;
        document.getElementById('export-import-chevron').textContent = isExportImportExpanded ? '▼' : '▶';
        document.getElementById('export-import-section-content').style.display = isExportImportExpanded ? 'block' : 'none';
    };

    // Sidebar buttons
    document.getElementById('add-board-btn').onclick = () => openModal('ADD_BOARD');
    document.getElementById('reorder-boards-btn').onclick = () => openModal('REORDER');
    document.getElementById('export-btn').onclick = handleExport;
    document.getElementById('export-board-btn').onclick = handleExportBoard;
    document.getElementById('import-btn').onclick = () => document.getElementById('import-file').click();
    document.getElementById('import-board-btn').onclick = () => document.getElementById('import-board-file').click();
    document.getElementById('import-text-btn').onclick = () => document.getElementById('import-text-file').click();
    document.getElementById('trash-btn').onclick = () => openModal('TRASH');
    document.getElementById('font-size-btn').onclick = () => openFontSizeModal();

    // Tabs (boards-nav) click-and-drag scroll behavior
    if (elements.boardsNav) {
        // Mouse click-and-drag scroll logic
        let isDown = false;
        let startX;
        let scrollLeft;
        let moved = false;

        elements.boardsNav.addEventListener('mousedown', (e) => {
            // Only toggle on left click (button 0)
            if (e.button !== 0) return;
            isDown = true;
            elements.boardsNav.classList.add('active-drag');
            startX = e.pageX - elements.boardsNav.offsetLeft;
            scrollLeft = elements.boardsNav.scrollLeft;
            moved = false;
        });

        elements.boardsNav.addEventListener('mouseleave', () => {
            if (isDown) {
                isDown = false;
                elements.boardsNav.classList.remove('active-drag');
                elements.boardsNav.classList.remove('is-dragging-active');
            }
        });

        elements.boardsNav.addEventListener('mouseup', () => {
            if (isDown) {
                isDown = false;
                elements.boardsNav.classList.remove('active-drag');
                setTimeout(() => {
                    elements.boardsNav.classList.remove('is-dragging-active');
                }, 0);
            }
        });

        elements.boardsNav.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            const x = e.pageX - elements.boardsNav.offsetLeft;
            const walk = (x - startX) * 1.5; // Drag speed multiplier
            if (Math.abs(walk) > 4) {
                moved = true;
                elements.boardsNav.classList.add('is-dragging-active');
            }
            elements.boardsNav.scrollLeft = scrollLeft - walk;
        });

        // Capture child clicks during active drag events to prevent accidental tab clicks
        elements.boardsNav.addEventListener('click', (e) => {
            if (moved) {
                e.preventDefault();
                e.stopPropagation();
                moved = false; // Reset state
            }
        }, true); // Capture phase is critical to run before child handlers
    }

    // Form
    elements.noteForm.onsubmit = (e) => {
        e.preventDefault();
        inputText = elements.noteInput.value;
        handleSaveNote();
    };

    // Note Creation Audio attachment handlers
    const micUploadBtn = document.getElementById('mic-upload-btn');
    const audioFileInput = document.getElementById('audio-file-input');
    const selectedAudioContainer = document.getElementById('selected-audio-container');
    const selectedAudioNameEl = document.getElementById('selected-audio-name');
    const removeSelectedAudioBtn = document.getElementById('remove-selected-audio-btn');

    if (micUploadBtn && audioFileInput) {
        micUploadBtn.onclick = () => {
            audioFileInput.click();
        };

        audioFileInput.onchange = (e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                selectedAudioFile = files[0];
                selectedAudioName = files[0].name;
                
                // Read as base64 for local board
                const reader = new FileReader();
                reader.onload = (readerEvent) => {
                    selectedAudioBase64 = readerEvent.target.result;
                };
                reader.readAsDataURL(selectedAudioFile);

                if (selectedAudioNameEl) selectedAudioNameEl.textContent = selectedAudioName;
                if (selectedAudioContainer) selectedAudioContainer.style.display = 'flex';
            }
        };
    }

    if (removeSelectedAudioBtn) {
        removeSelectedAudioBtn.onclick = () => {
            selectedAudioFile = null;
            selectedAudioBase64 = null;
            selectedAudioName = '';
            if (audioFileInput) audioFileInput.value = '';
            if (selectedAudioContainer) selectedAudioContainer.style.display = 'none';
        };
    }

    // Edit Note Audio attachment handlers
    const editMicBtn = document.getElementById('edit-mic-btn');
    const editAudioFileInput = document.getElementById('edit-audio-file-input');
    const editAudioStatus = document.getElementById('edit-audio-status');
    const editAudioNameEl = document.getElementById('edit-audio-name');
    const deleteEditAudioBtn = document.getElementById('delete-edit-audio-btn');
    const editMicLabel = document.getElementById('edit-mic-label');

    if (editMicBtn && editAudioFileInput) {
        editMicBtn.onclick = () => {
            editAudioFileInput.click();
        };

        editAudioFileInput.onchange = (e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                editSelectedAudioFile = files[0];
                editSelectedAudioName = files[0].name;

                // Read as base64
                const reader = new FileReader();
                reader.onload = (readerEvent) => {
                    editSelectedAudioBase64 = readerEvent.target.result;
                };
                reader.readAsDataURL(editSelectedAudioFile);

                if (editAudioNameEl) editAudioNameEl.textContent = editSelectedAudioName + " (جديد)";
                if (editAudioStatus) editAudioStatus.style.display = 'flex';
                if (editMicLabel) editMicLabel.textContent = 'استبدال الملف الصوتي';
                editAudioDeleted = false;
            }
        };
    }

    if (deleteEditAudioBtn) {
        deleteEditAudioBtn.onclick = () => {
            editSelectedAudioFile = null;
            editSelectedAudioBase64 = null;
            editSelectedAudioName = '';
            editAudioDeleted = true;
            if (editAudioFileInput) editAudioFileInput.value = '';
            if (editAudioStatus) editAudioStatus.style.display = 'none';
            if (editMicLabel) editMicLabel.textContent = 'إضافة ملف صوتي';
        };
    }

    elements.noteInput.oninput = (e) => {
        inputText = e.target.value;
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    };

    // Search
    elements.searchInput.oninput = (e) => {
        searchQuery = e.target.value;
        renderNotes();
    };

    // Filter/Sort
    const filterBtn = document.getElementById('filter-btn');
    const sortDropdown = document.getElementById('sort-dropdown');

    const updateSortDropdownUI = () => {
        document.querySelectorAll('.sort-dropdown-item').forEach(item => {
            const itemSort = item.getAttribute('data-sort');
            if (itemSort === sortOrder) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        const checkDesc = document.getElementById('check-timestamp-desc');
        const checkAsc = document.getElementById('check-timestamp-asc');
        const checkAlpha = document.getElementById('check-content-asc');
        
        if (checkDesc) checkDesc.style.display = sortOrder === 'timestamp-desc' ? 'inline' : 'none';
        if (checkAsc) checkAsc.style.display = sortOrder === 'timestamp-asc' ? 'inline' : 'none';
        if (checkAlpha) checkAlpha.style.display = sortOrder === 'content-asc' ? 'inline' : 'none';
    };

    if (filterBtn && sortDropdown) {
        filterBtn.onclick = (e) => {
            e.stopPropagation();
            const isOpen = sortDropdown.classList.contains('show');
            if (isOpen) {
                sortDropdown.classList.remove('show');
            } else {
                updateSortDropdownUI();
                sortDropdown.classList.add('show');
            }
        };

        document.querySelectorAll('.sort-dropdown-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                const newSort = item.getAttribute('data-sort');
                sortOrder = newSort;
                renderNotes();
                
                let sortString = '';
                if (sortOrder === 'timestamp-desc') sortString = 'الأحدث أولاً';
                else if (sortOrder === 'timestamp-asc') sortString = 'الأقدم أولاً';
                else if (sortOrder === 'content-asc') sortString = 'أبجدي';

                showToast(`تم الترتيب: ${sortString}`);
                sortDropdown.classList.remove('show');
            };
        });

        document.addEventListener('click', (e) => {
            if (!filterBtn.contains(e.target) && !sortDropdown.contains(e.target)) {
                sortDropdown.classList.remove('show');
            }
        });
    }

    // Modals
    elements.boardForm.onsubmit = handleBoardSubmit;
    document.getElementById('cancel-board').onclick = closeModal;
    document.getElementById('confirm-delete-board').onclick = handleBoardDelete;
    document.getElementById('cancel-delete-board').onclick = closeModal;
    document.getElementById('close-reorder').onclick = closeModal;
    document.getElementById('close-trash').onclick = closeModal;
    document.getElementById('empty-trash-btn').onclick = () => {
        if (trash.length === 0) {
            showToast('سلة المحذوفات فارغة');
            return;
        }
        showCustomConfirm('هل أنت متأكد من إفراغ سلة المحذوفات؟ سيتم حذف جميع النصوص نهائياً.', () => {
            trash = [];
            saveData();
            renderTrashModal();
            showToast('تم إفراغ سلة المحذوفات');
        });
    };
    document.getElementById('cancel-move').onclick = closeModal;
    document.getElementById('save-edit').onclick = handleEditSave;
    document.getElementById('cancel-edit').onclick = () => {
        const noteId = modal.data ? modal.data.id : null;
        closeModal();
        if (noteId && openMenuId === noteId) {
            setTimeout(() => {
                openMenuId = null;
                expandedNoteIds.delete(noteId);
                renderNotes();
            }, 5000);
        }
    };
    document.getElementById('close-edit').onclick = () => {
        const noteId = modal.data ? modal.data.id : null;
        closeModal();
        if (noteId && openMenuId === noteId) {
            setTimeout(() => {
                openMenuId = null;
                expandedNoteIds.delete(noteId);
                renderNotes();
            }, 5000);
        }
    };
    document.getElementById('close-translate').onclick = () => {
        const noteId = modal.data ? modal.data.id : null;
        closeModal();
        if (noteId && openMenuId === noteId) {
            setTimeout(() => {
                openMenuId = null;
                expandedNoteIds.delete(noteId);
                renderNotes();
            }, 5000);
        }
    };

    // Import file
    document.getElementById('import-file').onchange = handleImport;
    document.getElementById('import-board-file').onchange = handleImportBoard;
    document.getElementById('import-text-file').onchange = handleImportText;

    // Translation
    let translateTimeout;
    elements.originalText.oninput = () => {
        clearTimeout(translateTimeout);
        translateTimeout = setTimeout(async () => {
            const text = elements.originalText.value;
            if (!text.trim()) return;

            // Auto-detect language
            const isArabic = /\p{Script=Arabic}/u.test(text);
            const sourceLang = isArabic ? 'Arabic' : 'English';
            const targetLang = isArabic ? 'English' : 'Arabic';

            // Update selects
            elements.sourceLang.value = sourceLang;
            elements.targetLang.value = targetLang;

            // Set text direction
            elements.originalText.dir = isArabic ? 'rtl' : 'ltr';
            elements.translatedText.dir = isArabic ? 'ltr' : 'rtl';

            const result = await translateText(text, sourceLang, targetLang);
            elements.translatedText.value = result;
        }, 500); // Faster, 0.5s
    };

    document.getElementById('swap-langs').onclick = () => {
        const temp = elements.sourceLang.value;
        elements.sourceLang.value = elements.targetLang.value;
        elements.targetLang.value = temp;
        const tempText = elements.originalText.value;
        elements.originalText.value = elements.translatedText.value;
        elements.translatedText.value = tempText;

        // Update directions based on new original text
        const isArabic = /\p{Script=Arabic}/u.test(elements.originalText.value);
        elements.originalText.dir = isArabic ? 'rtl' : 'ltr';
        elements.translatedText.dir = isArabic ? 'ltr' : 'rtl';
    };

    document.getElementById('copy-original').onclick = () => {
        navigator.clipboard.writeText(elements.originalText.value);
        showToast('تم النسخ');
    };

    document.getElementById('copy-translated').onclick = () => {
        navigator.clipboard.writeText(elements.translatedText.value);
        showToast('تم النسخ');
    };

    document.getElementById('save-edit-translate').onclick = () => {
        if (!isOwner) {
            showToast('لا تمتلك صلاحية التعديل');
            return;
        }
        const newContent = elements.originalText.value;
        const noteId = modal.data.id;
        notes = notes.map(n => n.id === noteId ? { ...n, content: newContent } : n);
        saveData();
        renderNotes();
        closeModal();
        if (openMenuId === noteId) {
            setTimeout(() => {
                openMenuId = null;
                expandedNoteIds.delete(noteId);
                renderNotes();
            }, 5000);
        }
        showToast('تم حفظ التعديل');
    };

    elements.sourceLang.onchange = () => {
        const text = elements.originalText.value;
        if (!text.trim()) return;
        translateTimeout = setTimeout(async () => {
            const result = await translateText(text, elements.sourceLang.value, elements.targetLang.value);
            elements.translatedText.value = result;
        }, 500);
    };
    elements.targetLang.onchange = () => {
        const text = elements.originalText.value;
        if (!text.trim()) return;
        translateTimeout = setTimeout(async () => {
            const result = await translateText(text, elements.sourceLang.value, elements.targetLang.value);
            elements.translatedText.value = result;
        }, 500);
    };
}

// Back to top functionality
function initBackToTop() {
    const backToTopBtn = document.getElementById('back-to-top');
    backToTopBtn.onclick = () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    window.addEventListener('scroll', () => {
        if (window.scrollY > 250) {
            backToTopBtn.classList.add('show');
        } else {
            backToTopBtn.classList.remove('show');
        }
    });
}

// Initialize app
async function init() {
    initElements();
    await loadData();
    renderBoardsNav();
    updateCurrentBoardBtn();
    renderBoardsList();
    renderNotes();
    initEventListeners();
    applyOwnershipUIRestrictions();
    // Set initial state for boards list and collapsible sections
    document.getElementById('boards-section-content').style.display = isBoardsExpanded ? 'block' : 'none';
    document.getElementById('boards-chevron').textContent = isBoardsExpanded ? '▼' : '▶';

    document.getElementById('export-import-section-content').style.display = isExportImportExpanded ? 'block' : 'none';
    document.getElementById('export-import-chevron').textContent = isExportImportExpanded ? '▼' : '▶';
    initBackToTop();
    updateFontSize(); // Apply font size

    // Auth Init
    updateAuthUI();
    updateSyncBadge();

    // Firebase Auth State listener
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            await loadCloudData();
        } else {
            currentUser = null;
            await loadCloudData();
        }
        updateAuthUI();
    });
}

// Note menu functions
function toggleNoteMenu(noteId, actions) {
    if (openMenuId === noteId) {
        openMenuId = null;
    } else {
        openMenuId = noteId;
    }
    renderNotes();
}

function hideNoteMenu(noteId) {
    openMenuId = null;
    renderNotes();
}

// Font size modal
function openFontSizeModal() {
    document.getElementById('current-font-size').textContent = fontSize + 'px';
    document.getElementById('font-size-modal').classList.add('show');
}

function updateFontSize() {
    document.documentElement.style.setProperty('--font-size', fontSize + 'px');
    document.getElementById('current-font-size').textContent = fontSize + 'px';
    localStorage.setItem('app_font_size', fontSize.toString());
}

// Load font size
function loadFontSize() {
    const saved = localStorage.getItem('app_font_size');
    if (saved) {
        fontSize = parseInt(saved, 10);
        updateFontSize();
    }
}

// Event listeners for font size
document.getElementById('decrease-font').onclick = () => {
    if (fontSize > 10) {
        fontSize--;
        updateFontSize();
    }
};

document.getElementById('increase-font').onclick = () => {
    if (fontSize < 30) {
        fontSize++;
        updateFontSize();
    }
};

document.getElementById('close-font-size').onclick = () => {
    document.getElementById('font-size-modal').classList.remove('show');
};

// Hide menus when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.note-actions')) {
        document.querySelectorAll('.note-menu').forEach(m => m.classList.remove('show'));
    }
});

// Start the app
document.addEventListener('DOMContentLoaded', async () => {
    loadFontSize();
    await init();
});