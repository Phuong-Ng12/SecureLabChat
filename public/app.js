const {
    createApp,
    ref,
    computed,
    watch,
    nextTick
} = Vue;

// Where the browser keeps the login token between page loads
const TOKEN_KEY = 'secureLabChat.token';

// localStorage can be blocked (private window, strict settings), so never let it crash the app
function readToken() {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch (e) {
        return null;
    }
}

function saveToken(token) {
    try {
        localStorage.setItem(TOKEN_KEY, token);
    } catch (e) {
        /* the user will simply have to log in again after a refresh */
    }
}

function clearToken() {
    try {
        localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
        /* nothing to clear */
    }
}

// Notification mode is remembered per user in this browser: 'banner' (default) or 'silent'
function notifyModeKey(username) {
    return 'secureLabChat.notifyMode.' + username;
}

function readNotifyMode(username) {
    try {
        return localStorage.getItem(notifyModeKey(username)) === 'silent' ? 'silent' : 'banner';
    } catch (e) {
        return 'banner';
    }
}

function saveNotifyMode(username, mode) {
    try {
        localStorage.setItem(notifyModeKey(username), mode);
    } catch (e) {
        /* the choice just will not survive a refresh */
    }
}

// Browser pop-ups only work on https or localhost, so on a plain http LAN address
// the in-app banner is what nurses will actually see
function desktopAlertsSupported() {
    return window.isSecureContext && 'Notification' in window;
}

createApp({
    setup() {
        const isAuthenticated = ref(false);
        // true while a saved token is being checked, so the login form does not flash
        const isResuming = ref(!!readToken());
        const authError = ref('');
        const currentRoom = ref('#general');
        const chatHistory = ref([]);
        const isMobileMenuOpen = ref(false);
        const inputText = ref('');
        const currentView = ref('chat'); // 'chat' or 'admin'

        const currentUser = ref({
            name: '',
            role: ''
        });

        const loginForm = ref({
            username: '',
            password: ''
        });

        // The channels this user may open, sent by the server at login:
        // [{ room: '#dept-1', label: '#Pharmacy', canPost: true }, ...]
        const channels = ref([]);

        // ----- Announcement alerts -----
        const notifyMode = ref('banner');                 // 'banner' or 'silent'
        const announcementBanner = ref(null);             // { user, text, count } or null
        const canAskDesktopPermission = ref(
            desktopAlertsSupported() && Notification.permission === 'default'
        );
        const originalTitle = document.title;

        const isSilent = computed(() => notifyMode.value === 'silent');

        function toggleNotifyMode() {
            notifyMode.value = isSilent.value ? 'banner' : 'silent';
            saveNotifyMode(currentUser.value.name, notifyMode.value);
            // going silent also removes a banner that is already on screen
            if (isSilent.value) announcementBanner.value = null;
        }

        function askDesktopPermission() {
            if (!desktopAlertsSupported()) return;
            Notification.requestPermission().then(() => {
                canAskDesktopPermission.value = Notification.permission === 'default';
            });
        }

        function viewingAnnouncements() {
            return !showAdmin.value && currentRoom.value === '#announcements';
        }

        function dismissBanner() {
            announcementBanner.value = null;
        }

        function openAnnouncementsFromBanner() {
            announcementBanner.value = null;
            switchChannel('#announcements');
        }

        // tab-title flash for when browser pop-ups are not possible
        function flashTitle(text) {
            document.title = '(new) ' + text;
        }

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) document.title = originalTitle;
        });

        function showDesktopNotification(announcement) {
            if (desktopAlertsSupported() && Notification.permission === 'granted') {
                // deliberately no message text: it could show on a locked screen
                const note = new Notification('SecureLabChat', {
                    body: 'New announcement from ' + announcement.user,
                    tag: 'secure-lab-chat-announcement'
                });
                note.onclick = () => {
                    window.focus();
                    openAnnouncementsFromBanner();
                    note.close();
                };
            } else {
                flashTitle('New announcement');
            }
        }

        // #announcements first, then the others in the order the server sent them
        const sidebarChannels = computed(() => [
            ...channels.value.filter((c) => c.room === '#announcements'),
            ...channels.value.filter((c) => c.room !== '#announcements')
        ]);

        // the name to show for the current channel (a department room shows its department)
        const currentChannelLabel = computed(() => {
            const channel = channels.value.find((c) => c.room === currentRoom.value);
            return channel ? channel.label : currentRoom.value;
        });

        // The dashboard is only ever shown to an Admin (the server checks every admin action too)
        const isAdmin = computed(() => currentUser.value.role === 'Admin');
        const showAdmin = computed(() => currentView.value === 'admin' && isAdmin.value);

        // ---- Admin dashboard: departments ----
        const departments = ref([]);
        const departmentsLoading = ref(false);
        const newDepartmentName = ref('');
        const departmentPending = ref(false);
        const departmentMessage = ref({ type: '', text: '' }); // type: 'ok' or 'error'
        
        // ---- Admin dashboard: new user form ----
        const USER_ROLES = ['Staff', 'Supervisor', 'Manager', 'Admin'];
        const emptyUserForm = () => ({ username: '', password: '', role: 'Staff', departmentId: '' });
        const newUser = ref(emptyUserForm());
        const showUserPassword = ref(false);
        const userPending = ref(false);
        const userMessage = ref({ type: '', text: '' });

        // Supervisors and Staff belong to a department. Admin and Manager are company-wide.
        const roleNeedsDepartment = computed(() =>
            newUser.value.role === 'Staff' || newUser.value.role === 'Supervisor');

        // a company-wide role has no department, so forget a choice made for another role
        watch(() => newUser.value.role, () => {
            if (!roleNeedsDepartment.value) newUser.value.departmentId = '';
        });

        // Establish the local area network socket link
        const socket = io();

        // Every time the socket connects (page load, or reconnect after the server
        // restarted) try to continue the saved session instead of asking for a password.
        socket.on('connect', () => {
            const token = readToken();
            if (token) socket.emit('resume_session', token);
        });

        // If the server never answers, show the login form. The token is kept, so the
        // session still resumes by itself once the server is reachable again.
        setTimeout(() => {
            isResuming.value = false;
        }, 5000);

        socket.on('authenticated', (response) => {
            isResuming.value = false;

            if (response.success) {
                if (response.token) saveToken(response.token);

                const wasLoggedIn = isAuthenticated.value;
                currentUser.value.name = response.name;
                currentUser.value.role = response.role;
                notifyMode.value = readNotifyMode(response.name);
                isAuthenticated.value = true;
                authError.value = '';

                // the channel list comes from the server, so a new department channel
                // needs no code change here
                channels.value = response.channels || [
                    { room: '#general', label: '#general', canPost: false },
                    { room: '#announcements', label: '#announcements', canPost: false }
                ];

                // after a page refresh start in #announcements, like a normal login does
                if (!wasLoggedIn && response.resumed) currentRoom.value = '#announcements';

                // if the channel we were in is no longer ours (for example the user was
                // moved to another department), fall back to #announcements
                if (!channels.value.some((c) => c.room === currentRoom.value)) {
                    currentRoom.value = '#announcements';
                }

                // /admin opens the dashboard for an Admin, everyone else goes to the chat
                if (location.pathname === '/admin') {
                    if (response.role === 'Admin') {
                        currentView.value = 'admin';
                    } else {
                        currentView.value = 'chat';
                        history.replaceState({}, '', '/');
                    }
                }

                // Auto-fetch landing page history logs (also re-joins the room after a reconnect)
                socket.emit('join_room', currentRoom.value);
            } else if (response.resume) {
                // the saved token is not valid any more
                clearToken();
                if (isAuthenticated.value) {
                    resetToLogin(response.error);
                } else {
                    authError.value = response.error;
                }
            } else {
                authError.value = response.error;
            }
        });

        socket.on('load_history', (historyData) => {
            chatHistory.value = historyData;
            scrollToBottom();
        });

        socket.on('chat_message', (incomingMsg) => {
            // only show it if it belongs to the channel on screen
            if (incomingMsg.room !== currentRoom.value) return;

            // Append incoming message straight into the Vue active view array
            chatHistory.value.push(incomingMsg);
            scrollToBottom();
        });

        // Sent to everyone signed in, whichever channel they are looking at
        socket.on('announcement', (announcement) => {
            if (!isAuthenticated.value || isSilent.value) return;
            if (announcement.user === currentUser.value.name) return; // your own post

            // another tab: browser notification (or title flash when not possible)
            if (document.hidden) showDesktopNotification(announcement);

            // in-app banner, unless the announcement is already in front of the user
            if (viewingAnnouncements() && !document.hidden) return;
            const previous = announcementBanner.value;
            announcementBanner.value = {
                user: announcement.user,
                text: announcement.encrypted_text,
                count: previous ? previous.count + 1 : 1
            };
        });

        // opening #announcements by any route clears the banner
        watch([currentRoom, showAdmin], () => {
            if (viewingAnnouncements()) announcementBanner.value = null;
        });

        socket.on('security_alert', (msg) => {
            alert(msg);
        });

                // One listener for the answers to every admin action
        socket.on('admin_result', (result) => {
            if (result.action === 'list_departments') {
                departmentsLoading.value = false;
                if (result.success) {
                    departments.value = result.departments;
                } else {
                    departmentMessage.value = { type: 'error', text: result.error };
                }
            }

            if (result.action === 'create_department') {
                departmentPending.value = false;
                if (result.success) {
                    departments.value.push(result.department);
                    departments.value.sort((a, b) => a.name.localeCompare(b.name));
                    newDepartmentName.value = '';
                    departmentMessage.value = {
                        type: 'ok',
                        text: `Department "${result.department.name}" created.`
                    };
                } else {
                    departmentMessage.value = { type: 'error', text: result.error };
                }
            }

            if (result.action === 'create_user') {
                userPending.value = false;
                if (result.success) {
                    const made = result.user;
                    userMessage.value = {
                        type: 'ok',
                        text: `User "${made.username}" created as ${made.role}` +
                            (made.department ? ` in ${made.department}.` : '.')
                    };
                    // keep role and department (handy for adding several people),
                    // but never keep the password around
                    newUser.value.username = '';
                    newUser.value.password = '';
                    showUserPassword.value = false;
                } else {
                    userMessage.value = { type: 'error', text: result.error };
                }
            }
        });

        // Load the department list each time the dashboard opens
        watch(showAdmin, (visible) => {
            if (!visible) return;
            userMessage.value = { type: '', text: '' };
            departmentsLoading.value = true;
            socket.emit('list_departments');
        });

        function createDepartment() {
            const name = newDepartmentName.value.trim();
            if (!name) {
                departmentMessage.value = { type: 'error', text: 'Enter a department name.' };
                return;
            }
            if (departmentPending.value) return; // already waiting for the server

            departmentMessage.value = { type: '', text: '' };
            departmentPending.value = true;
            socket.emit('create_department', { name });
        }

        function createUser() {
            if (userPending.value) return; // already waiting for the server

            const form = newUser.value;
            const username = form.username.trim();
            const fail = (text) => {
                userMessage.value = { type: 'error', text };
            };

            // the server checks all of this again, these messages just save a round trip
            if (!username) return fail('Enter a username.');
            if (username.length > 50) return fail('Username must be 50 characters or fewer.');
            if (form.password.length < 8) return fail('Password must be at least 8 characters.');
            if (roleNeedsDepartment.value && form.departmentId === '') {
                return fail('Choose a department for this role.');
            }

            userMessage.value = { type: '', text: '' };
            userPending.value = true;
            socket.emit('create_user', {
                username,
                password: form.password,
                role: form.role,
                departmentId: roleNeedsDepartment.value ? Number(form.departmentId) : null
            });
        }


        function submitAuthentication() {
            authError.value = '';
            if (!loginForm.value.username.trim() || !loginForm.value.password) {
                authError.value = 'Please provide both a username and security password.';
                return;
            }
            socket.emit('authenticate', loginForm.value);
        }

        function openAdmin() {
            if (!isAdmin.value) return;
            currentView.value = 'admin';
            isMobileMenuOpen.value = false;
            if (location.pathname !== '/admin') history.pushState({}, '', '/admin');
        }

        function showChat() {
            currentView.value = 'chat';
            if (location.pathname === '/admin') history.pushState({}, '', '/');
        }

        // the browser Back and Forward buttons move between the chat and the dashboard
        window.addEventListener('popstate', () => {
            currentView.value = (isAdmin.value && location.pathname === '/admin') ? 'admin' : 'chat';
        });

        function switchChannel(targetRoom) {
            // picking a channel from the dashboard goes back to the chat
            const cameFromAdmin = currentView.value === 'admin';
            if (cameFromAdmin) showChat();
            if (targetRoom === currentRoom.value) {
                if (cameFromAdmin) isMobileMenuOpen.value = false;
                return;
            }

            socket.emit('leave_room', currentRoom.value);
            currentRoom.value = targetRoom;
            chatHistory.value = []; // Clear array view instantly

            socket.emit('join_room', targetRoom);
            isMobileMenuOpen.value = false; // Shut mobile view drawer links
        }

        function pushChatMessage() {
            if (!inputText.value.trim() || !canUserPostInCurrentRoom()) return;

            if (!inputText.value.trim()) return;

            // Emit package payload format matching backend tracking requirements
            socket.emit('chat_message', {
                room: currentRoom.value,
                text: inputText.value.trim()
            });
            inputText.value = ''; // Wipe user input field immediately
        }

        // The send box follows the server's answer for this channel, so the screen
        // always matches the rules the server enforces (the server still checks every message)
        function canUserPostInCurrentRoom() {
            const channel = channels.value.find((c) => c.room === currentRoom.value);
            return !!(channel && channel.canPost);
        }

        function scrollToBottom() {
            nextTick(() => {
                const el = document.getElementById('chatFeed');
                if (el) el.scrollTop = el.scrollHeight;
            });
        }

        // Back to the login form without telling the server (used by logout and
        // when the saved session turns out to be invalid)
        function resetToLogin(message = '') {
            isAuthenticated.value = false;
            currentUser.value = {
                name: '',
                role: ''
            };
            loginForm.value = {
                username: '',
                password: ''
            };
            authError.value = message;
            chatHistory.value = [];
            currentRoom.value = '#general';
            inputText.value = '';
            isMobileMenuOpen.value = false;
            currentView.value = 'chat';
            channels.value = [];
            notifyMode.value = 'banner';
            announcementBanner.value = null;
            document.title = originalTitle;
            
            // nothing from the admin pages stays in memory for the next user
            departments.value = [];
            departmentsLoading.value = false;
            newDepartmentName.value = '';
            departmentPending.value = false;
            departmentMessage.value = { type: '', text: '' };
            newUser.value = emptyUserForm();
            showUserPassword.value = false;
            userPending.value = false;
            userMessage.value = { type: '', text: '' };
        }

        function logout() {
            socket.emit('logout');
            clearToken();
            resetToLogin();
            if (location.pathname === '/admin') history.replaceState({}, '', '/');
        }

        // Logging out in another tab removes the token, so sign this tab out too
        window.addEventListener('storage', (event) => {
            if (event.key === TOKEN_KEY && !event.newValue && isAuthenticated.value) {
                resetToLogin('You were signed out in another tab.');
            }
        });

        return {
            isAuthenticated,
            isResuming,
            isAdmin,
            showAdmin,
            authError,
            currentRoom,
            chatHistory,
            isMobileMenuOpen,
            inputText,
            currentUser,
            loginForm,
            sidebarChannels,
            currentChannelLabel,
            submitAuthentication,
            departments,
            departmentsLoading,
            newDepartmentName,
            departmentPending,
            departmentMessage,
            createDepartment,
            USER_ROLES,
            newUser,
            showUserPassword,
            userPending,
            userMessage,
            roleNeedsDepartment,
            createUser,
            openAdmin,
            showChat,
            switchChannel,
            pushChatMessage,
            canUserPostInCurrentRoom,
            notifyMode,
            isSilent,
            toggleNotifyMode,
            announcementBanner,
            dismissBanner,
            openAnnouncementsFromBanner,
            canAskDesktopPermission,
            askDesktopPermission,
            logout
        };
    }
}).mount('#app');