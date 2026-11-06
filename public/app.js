const {
    createApp,
    ref,
    computed,
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

        const channelMatrix = ref(['#general', '#announcements']);

        // The dashboard is only ever shown to an Admin (the server checks every admin action too)
        const isAdmin = computed(() => currentUser.value.role === 'Admin');
        const showAdmin = computed(() => currentView.value === 'admin' && isAdmin.value);

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
                isAuthenticated.value = true;
                authError.value = '';

                // after a page refresh start in #announcements, like a normal login does
                if (!wasLoggedIn && response.resumed) currentRoom.value = '#announcements';

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
            // Append incoming message straight into the Vue active view array
            chatHistory.value.push(incomingMsg);
            scrollToBottom();
        });

        socket.on('security_alert', (msg) => {
            alert(msg);
        });


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
            if (!inputText.value.trim()) return;

            // Emit package payload format matching backend tracking requirements
            socket.emit('chat_message', {
                room: currentRoom.value,
                text: inputText.value.trim()
            });
            inputText.value = ''; // Wipe user input field immediately
        }

        // Enforce visible entry restrictions for input control trays
        function canUserPostInCurrentRoom() {
            const role = currentUser.value.role;
            const room = currentRoom.value;

            if (room === '#announcements') {
                // Only Manager or Admin can post in global updates
                return role === 'Manager' || role === 'Admin';
            }
            if (room === '#general') {
                // Manager, Admin, and Supervisor can post; Staff can only read
                return role === 'Manager' || role === 'Admin' || role === 'Supervisor';
            }
            return false;
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
            channelMatrix,
            submitAuthentication,
            openAdmin,
            showChat,
            switchChannel,
            pushChatMessage,
            canUserPostInCurrentRoom,
            logout
        };
    }
}).mount('#app');