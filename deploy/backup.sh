#!/usr/bin/env bash
# Back up WebSSH data (SQLite DB, recordings) from the Docker volume.
# The database is copied with SQLite's online backup via the running container,
# so it is consistent even while WebSSH is in use.
#   ./deploy/backup.sh [/path/to/backups]
# Restore: stop the stack, extract the archive into the volume, start again (see docs/INSTALL.md).
# NOTE: secrets in the DB are encrypted with MASTER_KEY — back up your .env (or the key) separately!
set -euo pipefail
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec webssh node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/webssh.db');
db.exec(\"VACUUM INTO '/tmp/webssh-backup.db'\");
" 2>/dev/null
docker exec webssh sh -c 'cd /tmp && mkdir -p wb && mv webssh-backup.db wb/webssh.db && cp -r /data/recordings wb/ 2>/dev/null || true; tar -C /tmp/wb -czf - . && rm -rf /tmp/wb' > "$DEST/webssh-$STAMP.tar.gz"
echo "Backup written to $DEST/webssh-$STAMP.tar.gz"
ls -1t "$DEST"/webssh-*.tar.gz | tail -n +15 | xargs -r rm --   # keep the 14 newest
