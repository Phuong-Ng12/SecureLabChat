const {
    createApp,
    ref,
    nextTick
} = Vue;

createApp({
    setup() {
        const isAuthenticated = ref(false);
        const authError = ref('');
        const currentRoom = ref('#general');
        const chatHistory = ref([]);
        const isMobileMenuOpen = ref(false);
        const inputText = ref('');

        const currentUser = ref({
            name: '',
            role: ''
        });

        const loginForm = ref({
            username: '',
            password: ''
        });

        const channelMatrix = ref(['#general', '#announcements']);

        // Establish the local area network socket link
        const socket = io();

        socket.on('authenticated', (response) => {
            if (response.success) {
                currentUser.value.name = response.name;
                currentUser.value.role = response.role;
                isAuthenticated.value = true;
                authError.value = '';

                // Auto-fetch landing page history logs
                socket.emit('join_room', currentRoom.value);
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

        function switchChannel(targetRoom) {
            if (targetRoom === currentRoom.value) return;

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

        function logout() {
            socket.emit('logout');

            isAuthenticated.value = false;
            currentUser.value = {
                name: '',
                role: ''
            };
            loginForm.value = {
                username: '',
                password: ''
            };
            authError.value = '';
            chatHistory.value = [];
            currentRoom.value = '#general';
            inputText.value = '';
            isMobileMenuOpen.value = false;
        }

        return {
            isAuthenticated,
            authError,
            currentRoom,
            chatHistory,
            isMobileMenuOpen,
            inputText,
            currentUser,
            loginForm,
            channelMatrix,
            submitAuthentication,
            switchChannel,
            pushChatMessage,
            canUserPostInCurrentRoom,
            logout
        };
    }
}).mount('#app');