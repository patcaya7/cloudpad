# Run in PowerShell from the project root after installing dependencies.
npm install
npm run tauri:build
Write-Host "Installer output should be in src-tauri/target/release/bundle/"
