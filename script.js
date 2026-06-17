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
let isOwner = true; // By default can write (local fallback mode)
let ownerEmail = null;
let googleDriveFileId = null;

// Firebase & Drive Helper Functions
async function firestoreWriteNote(note) {
    if (!db || !isOwner) return;
    try {
        await setDoc(doc(db, "notes", note.id), note);
    } catch (err) {
        console.error("Firestore write note error: ", err);
    }
}

async function firestoreDeleteNote(noteId) {
    if (!db || !isOwner) return;
    try {
        await deleteDoc(doc(db, "notes", noteId));
    } catch (err) {
        console.error("Firestore delete note error: ", err);
    }
}

async function firestoreWriteTrash(item) {
    if (!db || !isOwner) return;
    try {
        await setDoc(doc(db, "trash", item.id), item);
    } catch (err) {
        console.error("Firestore write trash error: ", err);
    }
}

async function firestoreDeleteTrash(itemId) {
    if (!db || !isOwner) return;
    try {
        await deleteDoc(doc(db, "trash", itemId));
    } catch (err) {
        console.error("Firestore delete trash error: ", err);
    }
}

async function firestoreWriteBoard(board) {
    if (!db || !isOwner) return;
    try {
        await setDoc(doc(db, "boards", board.id), board);
    } catch (err) {
        console.error("Firestore write board error: ", err);
    }
}

async function firestoreDeleteBoard(boardId) {
    if (!db || !isOwner) return;
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
            await setDoc(doc(db, "boards", board.id), board);
        }
        for (const note of notes) {
            await setDoc(doc(db, "notes", note.id), note);
        }
        for (const item of trash) {
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
    const content = JSON.stringify({ boards, notes, trash });
    
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

    // Hide or replace inputs if not owner
    const noteForm = document.getElementById('note-form');
    if (noteForm) {
        if (!isOwner) {
            noteForm.style.display = 'none';
            let banner = document.getElementById('readonly-banner');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'readonly-banner';
                banner.style.cssText = 'background: #fef2f2; border: 1px solid #fee2e2; padding: 1px; margin-top: 42px; border-radius: 8px; text-align: center; color: #991b1b; font-size: 11px; font-weight: bold; width: 100%;';
                banner.innerHTML = '🔒 وضع العرض فقط . لا تمتلك صلاحيات التعديل أو الحذف.';
                noteForm.parentNode.insertBefore(banner, noteForm);
            }
        } else {
            noteForm.style.display = 'flex';
            const banner = document.getElementById('readonly-banner');
            if (banner) banner.remove();
        }
    }
}

function updateSyncBadge() {
    const indicator = document.getElementById('sync-status-indicator');
    if (!indicator) return;
    
    if (currentUser && isOwner && ownerEmail) {
        indicator.innerHTML = `
            <div style="display: flex; gap: 6px; align-items: center;">
                <span id="badge-sync-trigger" class="sync-badge synced" style="cursor: pointer; user-select: none; font-size: 10px; padding: 2px 6px;" title="انقر للمزامنة الفورية السحابية">☁️ متصل</span>
            </div>
        `;
        const trigger = document.getElementById('badge-sync-trigger');
        if (trigger) {
            trigger.onclick = async () => {
                try {
                    trigger.textContent = '🔄 جاري...';
                    trigger.style.pointerEvents = 'none';
                    await uploadAllToFirestore();
                    if (googleAccessToken) {
                        try {
                            await uploadBackupToDrive(googleAccessToken, googleDriveFileId);
                        } catch (driveErr) {
                            console.error("Drive sync failed during header sync:", driveErr);
                        }
                    }
                    showToast("تم مزامنة ورفع كافة البيانات سحابياً بنجاح! ☁️");
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
        indicator.innerHTML = `<span class="sync-badge offline" style="background:#fee2e2; color:#991b1b; padding: 2px 6px; font-size: 10px; cursor: not-allowed;" title="أنت تتصفح نصوص المالك في وضع القراءة فقط">🔒 عرض فقط</span>`;
    } else {
        indicator.innerHTML = `<span id="badge-login-trigger" class="sync-badge offline" style="cursor: pointer; user-select: none; padding: 2px 6px; font-size: 10px;" title="انقر لتسجيل الدخول والمزامنة سحابياً">💾 حفظ محلي 🔑</span>`;
        const loginTrigger = document.getElementById('badge-login-trigger');
        if (loginTrigger) {
            loginTrigger.onclick = () => {
                isSidebarOpen = true;
                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebar-overlay');
                if (sidebar) sidebar.classList.add('open');
                if (overlay) overlay.classList.add('show');
                showToast("يرجى الضغط على 'تسجيل الدخول عبر الايميل' داخل القائمة الجانبية");
            };
        }
    }
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
            
            if (isOwner && currentUser) {
                // Safeguard: If the cloud is completely empty of boards and notes but we have local data,
                // automatically push our local data to the cloud rather than wiping it!
                if (cloudNotes.length === 0 && cloudBoards.length === 0 && (notes.length > 0 || boards.length > 0)) {
                    showToast("جاري رفع نصوصك ولوحاتك المحلية سحابياً للمزامنة...");
                    await uploadAllToFirestore();
                } else {
                    // Pull cloud data into memory
                    if (cloudBoards.length > 0) {
                        boards = cloudBoards;
                    }
                    notes = cloudNotes;
                    trash = cloudTrash;
                    
                    // Keep local storage in sync with cloud
                    localStorage.setItem('app_boards', JSON.stringify(boards));
                    localStorage.setItem('app_notes', JSON.stringify(notes));
                    localStorage.setItem('app_trash', JSON.stringify(trash));
                }
            } else {
                // Spectator (either not logged in, or logged in as different user): pull cloud data only
                if (cloudBoards.length > 0) {
                    boards = cloudBoards;
                } else {
                    boards = [{ id: '1', name: 'الافتراضية', order: 1 }];
                }
                notes = cloudNotes;
                trash = cloudTrash;
            }
            
            // Re-order and reset active board if needed
            boards = boards.sort((a,b) => a.order - b.order);
            if (!boards.find(b => b.id === activeBoardId)) {
                activeBoardId = boards[0]?.id || '1';
            }
            
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
                            boards = backup.boards;
                            notes = backup.notes || [];
                            trash = backup.trash || [];
                            localStorage.setItem('app_boards', JSON.stringify(boards));
                            localStorage.setItem('app_notes', JSON.stringify(notes));
                            localStorage.setItem('app_trash', JSON.stringify(trash));
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
        isOwner = true;
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
                    <span>مرحباً، <span class="auth-user-email">${currentUser.displayName || userMail}</span></span>
                    <span class="auth-status-tag">👑 المالك - مزامنة السحاب نشطة</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 5px; width: 100%;">
                    <button id="auth-force-sync-btn" class="auth-logout-btn" style="background-color: #2c3e50; color: white; border: none; font-weight: bold; width: 100%; cursor: pointer;">🔄 مزامنة ورفع كافة البيانات سحابياً</button>
                    <button id="auth-logout-btn" class="auth-logout-btn" style="width: 100%;">تسجيل الخروج</button>
                </div>
            `;
            
            const forceSyncBtn = document.getElementById('auth-force-sync-btn');
            if (forceSyncBtn) {
                forceSyncBtn.onclick = async () => {
                    try {
                        forceSyncBtn.textContent = '🔄 جاري المزامنة...';
                        forceSyncBtn.disabled = true;
                        await uploadAllToFirestore();
                        showToast("تم رفع ومزامنة كافة نصوصك ولوحاتك سحابياً بنجاح!");
                        
                        // Force update other drive systems too if possible
                        if (googleAccessToken) {
                            await uploadBackupToDrive(googleAccessToken, googleDriveFileId);
                        }
                    } catch (e) {
                        console.error("Manual sync failed: ", e);
                        showToast("فشلت المزامنة المباشرة، يرجى المحاولة لاحقاً");
                    } finally {
                        forceSyncBtn.textContent = '🔄 مزامنة ورفع كافة البيانات سحابياً';
                        forceSyncBtn.disabled = false;
                    }
                };
            }
        } else {
            authSection.innerHTML = `
                <div class="auth-user-info">
                    <span>مرحباً، <span class="auth-user-email">${currentUser.displayName || userMail}</span></span>
                    <span class="auth-status-tag readonly">👁️ قارئ (المالك: ${mailOwner})</span>
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
let expandedNoteIds = new Set(); // For text expansion
let openMenuId = null; // For menu and highlight
let fontSize = 14; // Default font size in px
let modal = { type: 'NONE', data: null };
let toastMessage = '';

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

// Load data from localStorage
function loadData() {
    try {
        const savedBoards = localStorage.getItem('app_boards');
        if (savedBoards) boards = JSON.parse(savedBoards);
        else boards = [
            { id: '1', name: 'عام', order: 0 },
            { id: '2', name: 'شخصي', order: 1 },
            { id: '3', name: 'عمل', order: 2 }
        ];

        const savedNotes = localStorage.getItem('app_notes');
        notes = savedNotes ? JSON.parse(savedNotes) : [];

        const savedTrash = localStorage.getItem('app_trash');
        trash = savedTrash ? JSON.parse(savedTrash) : [];
    } catch (e) {
        console.error('Failed to load data', e);
        boards = [
            { id: '1', name: 'عام', order: 0 },
            { id: '2', name: 'شخصي', order: 1 },
            { id: '3', name: 'عمل', order: 2 }
        ];
        notes = [];
        trash = [];
    }

    // Ensure activeBoardId is valid
    if (!boards.find(b => b.id === activeBoardId)) {
        activeBoardId = boards[0]?.id || '1';
    }
}

// Save data to localStorage
function saveData() {
    localStorage.setItem('app_boards', JSON.stringify(boards));
    localStorage.setItem('app_notes', JSON.stringify(notes));
    localStorage.setItem('app_trash', JSON.stringify(trash));
    
    if (googleAccessToken && isOwner && currentUser) {
        uploadBackupToDrive(googleAccessToken, googleDriveFileId).catch(err => {
            console.error("Google Drive auto-backup error:", err);
        });
    }
}

// Show toast
function showToast(message) {
    toastMessage = message;
    elements.toastMessage.textContent = message;
    elements.toast.classList.add('show');
    setTimeout(() => {
        elements.toast.classList.remove('show');
    }, 3000);
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
        btn.textContent = board.name;
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
        name.textContent = board.name;

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

        if (isOwner) {
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
        }
        item.appendChild(name);
        if (isOwner) {
            item.appendChild(actions);
        }
        elements.boardsList.appendChild(item);
    });
}

// Render notes
function renderNotes() {
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
        item.className = `note-item ${expandedNoteIds.has(note.id) ? 'active' : ''} ${note.id === openMenuId ? 'menu-open' : ''}`;

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
        date.textContent = new Date(note.timestamp).toLocaleDateString('ar-EG', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });

        meta.appendChild(date);
        content.appendChild(text);
        content.appendChild(meta);

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

        menu.appendChild(copyBtn);
        if (isOwner) {
            menu.appendChild(editBtn);
            menu.appendChild(moveBtn);
        }
        menu.appendChild(translateBtn);
        if (isOwner) {
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

// Actions
function handleSaveNote() {
    if (!inputText.trim()) return;

    const newNote = {
        id: crypto.randomUUID(),
        boardId: activeBoardId,
        content: inputText,
        timestamp: Date.now()
    };

    notes = [newNote, ...notes];
    inputText = '';
    elements.noteInput.value = '';
    elements.noteInput.style.height = 'auto'; // Reset height
    saveData();
    firestoreWriteNote(newNote);
    renderNotes();
    renderBoardsNav();
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

    if (modal.type === 'ADD_BOARD') {
        const newBoard = {
            id: crypto.randomUUID(),
            name,
            order: boards.length
        };
        boards = [...boards, newBoard];
        activeBoardId = newBoard.id;
        showToast('تمت الإضافة');
        firestoreWriteBoard(newBoard);
    } else if (modal.type === 'EDIT_BOARD_NAME') {
        const updatedBoard = { ...modal.data, name };
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

function handleEditSave() {
    const content = document.getElementById('edit-note-textarea').value;
    const noteId = modal.data.id;
    const updatedNote = { ...modal.data, content };
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

function handleExport() {
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
            const handle = window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'JSON Backup File',
                    accept: { 'application/json': ['.json'] },
                }],
            }).then(handle => {
                return handle.createWritable();
            }).then(writable => {
                writable.write(blob);
                writable.close();
                showToast('تم حفظ النسخة بنجاح');
            });
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn("showSaveFilePicker failed, using fallback", err);
                downloadFallback();
            }
        }
    } else {
        showCustomAlert('متصفحك لا يدعم نافذة اختيار مكان الحفظ، سيتم التنزيل في المجلد الافتراضي للمتصفح.');
        downloadFallback();
    }
}

function handleExportBoard() {
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
            const handle = window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'Board Backup File',
                    accept: { 'application/json': ['.json'] },
                }],
            }).then(handle => {
                return handle.createWritable();
            }).then(writable => {
                writable.write(new Blob([data], { type: 'application/json' }));
                writable.close();
                showToast('تم حفظ اللوحة بنجاح');
            });
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
        elements.boardsList.style.display = isBoardsExpanded ? 'block' : 'none';
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

    // Form
    elements.noteForm.onsubmit = (e) => {
        e.preventDefault();
        inputText = elements.noteInput.value;
        handleSaveNote();
    };

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
    document.querySelector('.filter-btn').onclick = () => {
        if (sortOrder === 'timestamp-desc') {
            sortOrder = 'timestamp-asc';
        } else if (sortOrder === 'timestamp-asc') {
            sortOrder = 'content-asc';
        } else {
            sortOrder = 'timestamp-desc';
        }
        renderNotes();
        showToast(`تم الترتيب: ${sortOrder === 'timestamp-desc' ? 'الأحدث أولاً' : sortOrder === 'timestamp-asc' ? 'الأقدم أولاً' : 'أبجدي'}`);
    };

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
function init() {
    initElements();
    loadData();
    renderBoardsNav();
    updateCurrentBoardBtn();
    renderBoardsList();
    renderNotes();
    initEventListeners();
    // Set initial state for boards list
    elements.boardsList.style.display = isBoardsExpanded ? 'block' : 'none';
    document.getElementById('boards-chevron').textContent = isBoardsExpanded ? '▼' : '▶';
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
document.addEventListener('DOMContentLoaded', () => {
    loadFontSize();
    init();
});