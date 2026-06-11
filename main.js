const { app, BrowserWindow, ipcMain, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── Constantes mise à jour ──────────────────────────────────────────────────
const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/shootinger/streamhub/main/version.json';
const STREAMHUB_UPDATE_DIR = path.join(os.homedir(), 'AppData', 'Local', 'streamhub-updater');
const PENDING_INSTALLER_PATH = path.join(STREAMHUB_UPDATE_DIR, 'streamhub-setup.exe');
const PENDING_INSTALLER_MARKER = path.join(STREAMHUB_UPDATE_DIR, 'update-ready.txt');

// ── Helpers ─────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000, headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        res.resume();
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON: ' + data.substring(0, 100))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Téléchargement binaire avec suivi de progression réelle + redirections
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function doRequest(currentUrl, redirectsLeft) {
      if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
      const mod = currentUrl.startsWith('https') ? https : http;
      const req = mod.get(currentUrl, { headers: { 'User-Agent': 'StreamHub-Updater' }, timeout: 30000 }, (res) => {
        // Suivre les redirections (GitHub → S3)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return doRequest(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(destPath);

        res.on('data', chunk => {
          file.write(chunk);
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.min(99, Math.round((received / total) * 100)));
          }
        });
        res.on('end', () => {
          file.end(() => {
            if (onProgress) onProgress(100);
            resolve(destPath);
          });
        });
        res.on('error', err => { file.destroy(); reject(err); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    }
    doRequest(url, 10);
  });
}

// Comparaison semver : retourne true si remote > current
function isNewerVersion(remote, current) {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const c = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// Lance l'installeur téléchargé via Task Scheduler (pour avoir les droits admin)
function launchPendingInstaller() {
  const logFile = path.join(os.tmpdir(), 'streamhub-update-log.txt');
  const log = (msg) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  };

  log('launchPendingInstaller called');
  log(`installer: ${PENDING_INSTALLER_PATH}`);
  log(`exists: ${fs.existsSync(PENDING_INSTALLER_PATH)}`);

  // Débloquer le fichier (téléchargé depuis Internet)
  try {
    execSync(`powershell.exe -NonInteractive -Command "Unblock-File -LiteralPath '${PENDING_INSTALLER_PATH}'"`, { timeout: 5000 });
    log('Unblock-File OK');
  } catch (e) { log('Unblock-File failed: ' + e.message); }

  // Script PowerShell qui lance l'installeur en mode élevé
  const ps1File = path.join(os.tmpdir(), 'streamhub-update.ps1');
  const exeExists = `(Test-Path '${PENDING_INSTALLER_PATH}')`;
  fs.writeFileSync(ps1File,
    `Add-Content '${logFile}' "[$(Get-Date -Format o)] Task fired"\r\n` +
    `if (${exeExists}) {\r\n` +
    `  $shell = New-Object -ComObject Shell.Application\r\n` +
    `  $shell.ShellExecute('${PENDING_INSTALLER_PATH}', '', '', 'runas', 1)\r\n` +
    `  Add-Content '${logFile}' "[$(Get-Date -Format o)] ShellExecute done"\r\n` +
    `} else {\r\n` +
    `  Add-Content '${logFile}' "[$(Get-Date -Format o)] FILE MISSING"\r\n` +
    `}\r\n`
  );

  const ps1Esc = ps1File.replace(/\\/g, '\\\\');
  const psScript = [
    `$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive`,
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File \\"${ps1Esc}\\"'`,
    `$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(3)`,
    `Register-ScheduledTask -TaskName StreamHubUpdate -Action $a -Trigger $t -Principal $p -Force`
  ].join('; ');

  try {
    execSync(`powershell.exe -NonInteractive -Command "${psScript}"`, { timeout: 15000 });
    log('Register-ScheduledTask OK');
  } catch (e) { log('Register-ScheduledTask FAILED: ' + e.message); }

  log('quitting in 2s...');
  setTimeout(() => app.quit(), 2000);
}

// ── Fenêtre principale ───────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Créatique',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0D0F14',
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Si un installeur est déjà téléchargé et prêt → le lancer directement
  if (fs.existsSync(PENDING_INSTALLER_MARKER) && fs.existsSync(PENDING_INSTALLER_PATH)) {
    try { fs.unlinkSync(PENDING_INSTALLER_MARKER); } catch {}
    launchPendingInstaller();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Instance unique
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── IPC : Contrôles fenêtre ──────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('get-version', () => app.getVersion());

// ── IPC : Mises à jour ───────────────────────────────────────────────────────
let pendingDownloadUrl = null;
let autoDownloadInProgress = false;

ipcMain.handle('check-update', async () => {
  try {
    const url = UPDATE_CHECK_URL + '?t=' + Date.now();
    const remote = await httpGet(url, { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' });
    const current = app.getVersion();

    if (!remote.version || !isNewerVersion(remote.version, current)) {
      return { available: false, current, remoteVersion: remote.version || current };
    }

    const v = remote.version;
    pendingDownloadUrl = remote.download ||
      `https://github.com/shootinger/streamhub/releases/download/v${v}/StreamHub.Setup.${v}.exe`;

    // Installeur déjà téléchargé ?
    if (fs.existsSync(PENDING_INSTALLER_MARKER) && fs.existsSync(PENDING_INSTALLER_PATH)) {
      return { available: true, version: v, current, ready: true };
    }

    return { available: true, version: v, current, ready: false };
  } catch (err) {
    return { available: false, error: err.message };
  }
});

// Démarre le téléchargement en arrière-plan
ipcMain.handle('start-download', async (event) => {
  if (!pendingDownloadUrl || autoDownloadInProgress) return;
  autoDownloadInProgress = true;

  fs.mkdirSync(STREAMHUB_UPDATE_DIR, { recursive: true });
  try { fs.unlinkSync(PENDING_INSTALLER_PATH); } catch {}
  try { fs.unlinkSync(PENDING_INSTALLER_MARKER); } catch {}

  downloadFile(pendingDownloadUrl, PENDING_INSTALLER_PATH, (percent) => {
    event.sender.send('update-download-progress', percent);
  }).then(() => {
    const v = pendingDownloadUrl.match(/v([\d.]+)\//)?.[1] || '';
    fs.writeFileSync(PENDING_INSTALLER_MARKER, v);
    autoDownloadInProgress = false;
    event.sender.send('update-download-ready', v);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Créatique',
        body: `Mise à jour v${v} prête — cliquez Redémarrer pour installer.`
      }).show();
    }
  }).catch((err) => {
    autoDownloadInProgress = false;
    event.sender.send('update-download-error', err.message);
  });
});

// Redémarre l'app pour installer la mise à jour
ipcMain.handle('install-and-restart', async () => {
  if (fs.existsSync(PENDING_INSTALLER_PATH)) {
    try { fs.writeFileSync(PENDING_INSTALLER_MARKER, '1'); } catch {}
  }
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('open-url', async (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
  }
});
