# Node.js 24 LTS — Local Setup

## Architecture Target

The ISF platform requires **Node.js 24 LTS** (codename Krypton).

Current verified installation: **v24.21.0** at `C:\nodejs\node-v24.21.0-win-x64\`.

---

## Current Machine Configuration (Windows)

Node.js 24.21.0 LTS is installed as a portable directory (no installer, no system PATH modification):

```
C:\nodejs\
  node-v20.18.0-win-x64\    ← old, no longer primary
  node-v24.21.0-win-x64\    ← current target
    node.exe
    npm.cmd
    npx.cmd
```

### Setting Node 24 as Active in a PowerShell Session

```powershell
$env:PATH = "C:\nodejs\node-v24.21.0-win-x64;$env:PATH"
node --version  # → v24.21.0
```

### Setting Node 24 as System Default (one-time)

Run as Administrator:
```powershell
[System.Environment]::SetEnvironmentVariable(
  "PATH",
  "C:\nodejs\node-v24.21.0-win-x64;" + [System.Environment]::GetEnvironmentVariable("PATH", "Machine"),
  "Machine"
)
```
Then open a new terminal and verify: `node --version`

---

## Recommended: Use a Version Manager

For future Node.js version management, install one of:

### Option A: fnm (Fast Node Manager) — Recommended for Windows
```powershell
# Install fnm via winget
winget install Schniz.fnm

# Then in your shell profile (~/.profile or PowerShell profile):
fnm env --use-on-cd | Out-String | Invoke-Expression

# Install and use Node 24 LTS:
fnm install 24
fnm use 24
```

### Option B: nvm for Windows
```
https://github.com/coreybutler/nvm-windows/releases
```
After installing:
```powershell
nvm install 24
nvm use 24
```

---

## npm Install Scripts Policy (npm 11+)

npm 11 (bundled with Node 24) requires explicit approval of packages with native build scripts.
The following packages in this project have been approved:

| Package | Reason |
|---------|--------|
| `esbuild@0.18.20` | tsx dependency — esbuild binary |
| `esbuild@0.19.12` | tsx dependency — esbuild binary |
| `esbuild@0.25.12` | vitest dependency — esbuild binary |
| `esbuild@0.28.2` | drizzle-kit dependency — esbuild binary |
| `argon2@0.41.1` | Password hashing — native Node-gyp build |

Approval is stored in `.npmrc` / `package.json`. If running on a fresh clone:
```powershell
npm install-scripts approve esbuild
npm install-scripts approve argon2
npm ci
```

---

## Engine Requirement

`package.json` enforces `"node": ">=24.0.0"`.
Attempting to install with Node 20 or earlier will produce a warning and may produce incorrect native binaries for argon2 and esbuild.

---

## Verification

After setup, verify:
```powershell
node --version   # v24.x.x
npm --version    # 11.x.x
npm ci           # exits 0
npm run typecheck  # exits 0
npm run lint       # exits 0
npm test           # 38/38 passed
```
