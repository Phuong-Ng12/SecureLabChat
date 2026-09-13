# Secure Lab Chat

Vision: This application runs a secure, role-based real-time chat application completely containerized via Docker and orchestrated for offline networks.

For now: A basic chat-via-local-network browser app has been established. Follow the steps below to set up and run this app with Docker container.

Run the server on your computer. Other computers and mobile phones can access the chat page on the browser through your IP address:port. To get the real physical IP address of your computer, take the IPv4 address under `Wireless LAN adapter Wi-Fi` if you are using Wi-Fi.

## Requirements
Before starting, ensure you have **Docker Desktop** installed on your laptop.

## Quick Start Guide for Teammates

### 1. Setup Your Environment Locally
Open your terminal, navigate to your work directory, and run:
```bash
# Clone the repository
git clone <THIS_REPOSITORY_URL>
cd secure-lab-chat

# Checkout the shared staging branch
git checkout staging

# Create an isolated feature branch for your assigned task
git checkout -b feature/your-feature-name
```

### 2. Launch the Development Local Server
To start building your code with **Live Reloading (Hot Reload)** enabled, run:
```bash
docker-compose up --build
```
* Leave this terminal window open. Whenever you hit **Save** inside VS Code, the server inside the container will automatically reboot itself.
* Access the app interface locally at: **`http://localhost:3000`**

### 3. Basic Code Rules
* **Database Updates:** SQLite updates save inside the local `./data` folder automatically. Do not delete this folder.
* **Frontend Changes:** Keep edits isolated within `index.html`.
* **Backend Changes:** Keep socket event listeners isolated within `server.js`.

### Branch & Code Contribution Standard
Once your feature passes local multi-window testing:
1. Turn off your local container grid using `docker-compose down`.
2. Commit your code modifications:
   ```bash
   git add .
   git commit -m "feat: description of changes made"
   git push origin feature/your-feature-name
   ```
3. Open a Pull Request (PR) to Staging:
Go to GitHub and click Compare & pull request.
**CRITICAL:** Change the "base" dropdown to `staging`, and set the "compare" dropdown to `feature/notifications`.
Let your teammates review the code changes. Once approved, merge it into `staging`.
Do not target `main`.

4. Deploying to Main:
Once your tests prove everything on the `staging` branch is stable, open a final Pull Request on GitHub matching **Base: `main` <--- compare: `staging`**. Merging this PR represents an official deployment release.
