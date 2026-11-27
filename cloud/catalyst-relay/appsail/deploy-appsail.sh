#!/usr/bin/env bash
# Operator-only. NOT run by anyone automatically. Deploys the relay as the AppSail service "squeak-relay" (Development env).
# Fills the secrets the same way deploy-hosted.sh does (cloud.json relay key, .env SQUEAK_CLIQ_KEY), into a temp copy only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="${SQUEAK_SUPPORT_DIR:-$HOME/Library/Application Support/squeak}"
PROJECT_ID="${SQUEAK_CATALYST_PROJECT_ID:-53069000000381140}"
command -v catalyst >/dev/null || { echo "catalyst CLI not found"; exit 1; }
catalyst whoami >/dev/null 2>&1 || { echo "Not signed in: run 'catalyst login'"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"
"$HERE/build.sh" "$TMP/app"
if [ -f "$SUPPORT/catalyst-relay/.catalystrc" ]; then cp "$SUPPORT/catalyst-relay/.catalystrc" "$TMP/.catalystrc"; else (cd "$TMP" && catalyst init -p "$PROJECT_ID" -ni >/dev/null); fi
SUPPORT="$SUPPORT" APP="$TMP/app" HERE="$HERE" node -e '
const fs=require("fs"),path=require("path");
const cfg=JSON.parse(fs.readFileSync(path.join(process.env.HERE,"app-config.json"),"utf8"));
cfg.build_path=process.env.APP;
let key=process.env.RELAY_KEY;
if(!key){const c=JSON.parse(fs.readFileSync(path.join(process.env.SUPPORT,"cloud.json"),"utf8"));key=c.catalyst&&c.catalyst.relayKey;}
if(!key){console.error("No RELAY_KEY");process.exit(1);}
let cliq=process.env.SQUEAK_CLIQ_KEY;
if(!cliq){try{const l=fs.readFileSync(path.join(process.env.SUPPORT,".env"),"utf8").split(/\r?\n/).find(x=>/^\s*SQUEAK_CLIQ_KEY\s*=/.test(x));cliq=l&&l.slice(l.indexOf("=")+1).trim();}catch{}}
const e=cfg.env_variables; e.RELAY_KEY=key; e.SQUEAK_RELAY_HOSTED="1"; if(cliq)e.CLIQ_KEY=cliq;
for(const k of ["SQUEAK_ZOHO_CLIENT_ID","SQUEAK_ZOHO_CLIENT_SECRET","SQUEAK_ZOHO_REDIRECT_URI","SQUEAK_MAIL_FROM","SQUEAK_WEB_PREVIEW_ORIGINS","SQUEAK_NO_CATALYST_USER","SQUEAK_ACCOUNT_URL","SQUEAK_PEOPLE_TABLES","SQUEAK_BLOB_BUCKET","SQUEAK_MIN_MAC_VERSION","SQUEAK_CLEAN_START"])if(process.env[k])e[k]=process.env[k];if(!process.env.SQUEAK_MAIL_FROM){const m=(()=>{try{const l=require("fs").readFileSync(require("path").join(process.env.HOME,"Library/Application Support/squeak/.env"),"utf8").split(/\r?\n/).find(x=>/^\s*SQUEAK_MAIL_FROM\s*=/.test(x));return l&&l.slice(l.indexOf("=")+1).trim();}catch{return undefined}})();if(m)e.SQUEAK_MAIL_FROM=m;}
const out=JSON.stringify(cfg,null,2)+"\n";fs.writeFileSync(path.join(process.env.APP,"app-config.json"),out,{mode:0o600});fs.writeFileSync(path.join(path.dirname(process.env.APP),"app-config.json"),out,{mode:0o600});'
cd "$TMP"
catalyst deploy appsail --name squeak-relay --build-path "$TMP/app" --stack node22 --command "node server.js"
echo "Deployed. Then: curl https://<service>-<zaid>.development.catalystappsail.in/health"
