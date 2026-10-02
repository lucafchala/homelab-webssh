/**
 * Offline command reference, focused on what you need to run a homelab.
 * Each entry: name, category, summary, usage, common options, examples, related.
 */
export interface CommandHelp {
  name: string;
  category: string;
  summary: string;
  usage: string;
  options: [string, string][];
  examples: [string, string][];
  related?: string[];
  danger?: string;
}

const c = (
  name: string,
  category: string,
  summary: string,
  usage: string,
  options: [string, string][],
  examples: [string, string][],
  related?: string[],
  danger?: string,
): CommandHelp => ({ name, category, summary, usage, options, examples, related, danger });

export const COMMANDS: CommandHelp[] = [
  // ------------------------------------------------------------ Files & directories
  c('ls', 'Files', 'List directory contents', 'ls [options] [path…]',
    [['-l', 'long format (permissions, owner, size, date)'], ['-a', 'include hidden dot-files'], ['-h', 'human-readable sizes'], ['-t', 'sort by modification time'], ['-S', 'sort by size'], ['-r', 'reverse order'], ['-R', 'recurse into directories'], ['-d', 'list directories themselves, not contents']],
    [['ls -lah', 'everything, human-readable'], ['ls -lt | head', '10 most recently modified'], ['ls -lS /var/log | head', 'largest log files'], ['ls -ld */', 'only directories']],
    ['tree', 'find', 'stat']),
  c('cd', 'Files', 'Change the current directory', 'cd [dir]',
    [['-', 'go back to the previous directory'], ['~', 'your home directory'], ['..', 'parent directory']],
    [['cd -', 'toggle between the last two directories'], ['cd ~/docker', 'go into ~/docker']], ['pwd', 'pushd']),
  c('pwd', 'Files', 'Print the current working directory', 'pwd [-P]', [['-P', 'resolve symlinks']], [['pwd -P', 'physical path']], ['cd']),
  c('cp', 'Files', 'Copy files and directories', 'cp [options] SRC… DEST',
    [['-r', 'copy directories recursively'], ['-a', 'archive: recursive + keep permissions, owners, times, links'], ['-i', 'ask before overwriting'], ['-n', 'never overwrite'], ['-u', 'only copy when source is newer'], ['-v', 'verbose']],
    [['cp -a /etc/nginx /etc/nginx.bak', 'back up a config directory'], ['cp config.yml{,.bak}', 'quick backup using brace expansion']], ['rsync', 'mv']),
  c('mv', 'Files', 'Move or rename files', 'mv [options] SRC… DEST',
    [['-i', 'ask before overwriting'], ['-n', 'never overwrite'], ['-v', 'verbose']],
    [['mv old.conf new.conf', 'rename'], ['mv *.log archive/', 'move all logs into a folder']], ['cp', 'rename']),
  c('rm', 'Files', 'Remove files or directories', 'rm [options] FILE…',
    [['-r', 'remove directories recursively'], ['-f', 'force, never prompt'], ['-i', 'prompt before every removal'], ['-I', 'prompt once before removing many files'], ['-v', 'verbose']],
    [['rm -i file', 'remove with confirmation'], ['rm -rI build/', 'remove a directory, asking once'], ['find . -name "*.tmp" -delete', 'safer bulk delete by pattern']],
    ['trash-put', 'find', 'shred'], 'There is no undo. Double-check paths and variables — `rm -rf "$DIR/"` with an empty $DIR deletes /.'),
  c('mkdir', 'Files', 'Create directories', 'mkdir [options] DIR…', [['-p', 'create parents as needed, no error if exists'], ['-m', 'set mode, e.g. -m 700']],
    [['mkdir -p ~/docker/{nginx,postgres}/data', 'nested tree in one go'], ['mkdir -m 700 ~/.ssh', 'private directory']], ['rmdir']),
  c('ln', 'Files', 'Create links', 'ln [-s] TARGET LINK_NAME', [['-s', 'symbolic (soft) link'], ['-f', 'replace existing link'], ['-n', 'treat LINK_NAME as normal file if it is a symlink to a dir']],
    [['ln -s /mnt/tank/media ~/media', 'symlink a dataset into home'], ['ln -sfn /opt/app-v2 /opt/app', 'atomically switch a "current" symlink']], ['readlink']),
  c('touch', 'Files', 'Create an empty file or update timestamps', 'touch FILE…', [['-d', 'set a specific date'], ['-r', 'copy timestamp from another file']], [['touch .env', 'create empty file']], ['stat']),
  c('cat', 'Files', 'Print and concatenate files', 'cat [options] FILE…', [['-n', 'number lines'], ['-A', 'show non-printing chars (tabs, line ends)']],
    [['cat /etc/os-release', 'which distro is this?'], ['cat -A file', 'find stray tabs / CRLF line endings']], ['less', 'bat', 'tac']),
  c('less', 'Files', 'Page through a file', 'less [options] FILE', [['+F', 'follow mode like tail -f (Ctrl-C to stop)'], ['-S', 'chop long lines'], ['-N', 'line numbers'], ['-R', 'show colours']],
    [['less +F /var/log/syslog', 'follow a log, scroll back anytime'], ['journalctl -u nginx | less', 'page through output']], ['more', 'tail']),
  c('head', 'Files', 'First lines of a file', 'head [-n N] FILE', [['-n N', 'first N lines'], ['-c N', 'first N bytes']], [['head -n 20 access.log', 'first 20 lines']], ['tail']),
  c('tail', 'Files', 'Last lines of a file, optionally follow', 'tail [options] FILE', [['-n N', 'last N lines'], ['-f', 'follow appended data'], ['-F', 'follow by name (survives log rotation)']],
    [['tail -F /var/log/nginx/error.log', 'watch errors live'], ['tail -n 100 file', 'last 100 lines']], ['head', 'journalctl', 'less']),
  c('tree', 'Files', 'Show a directory tree', 'tree [options] [dir]', [['-L N', 'max depth'], ['-a', 'include hidden'], ['-d', 'directories only'], ['-h', 'sizes'], ['--du', 'cumulative dir sizes']],
    [['tree -L 2 ~/docker', 'two levels deep']], ['ls', 'find']),
  c('stat', 'Files', 'Detailed file metadata', 'stat FILE', [['-c FORMAT', 'custom output, e.g. %a for octal permissions']], [['stat -c "%a %U:%G %n" *', 'permissions and owner for each file']], ['ls']),
  c('file', 'Files', 'Detect a file\'s type', 'file FILE…', [['-i', 'print MIME type']], [['file backup.img', 'what is this blob?']], ['stat']),
  c('du', 'Disks', 'Disk usage of files/directories', 'du [options] [path]', [['-s', 'summary per argument'], ['-h', 'human sizes'], ['-x', 'stay on one filesystem'], ['-d N', 'max depth']],
    [['du -sh * | sort -h', 'sizes of everything here, smallest → largest'], ['du -xh / -d 1 2>/dev/null | sort -h | tail', 'biggest top-level dirs on root fs']], ['df', 'ncdu']),
  c('ncdu', 'Disks', 'Interactive disk usage explorer', 'ncdu [options] [dir]', [['-x', 'same filesystem only'], ['-e', 'extended info']], [['ncdu -x /', 'find what is filling the root disk']], ['du']),
  c('find', 'Search', 'Search for files by name, size, time, type…', 'find [path] [tests] [actions]',
    [['-name "*.log"', 'match name (case-sensitive), -iname for insensitive'], ['-type f|d|l', 'files / directories / links'], ['-size +100M', 'bigger than 100 MB'], ['-mtime -1', 'modified in last 24 h'], ['-mmin -30', 'modified in last 30 min'], ['-user bob', 'owned by user'], ['-exec CMD {} +', 'run a command on results'], ['-delete', 'delete matches (put it last!)']],
    [['find / -xdev -type f -size +1G 2>/dev/null', 'files larger than 1 GB'], ['find /var/log -name "*.gz" -mtime +30 -delete', 'delete compressed logs older than 30 days'], ['find . -type d -empty', 'empty directories'], ['find ~/docker -name docker-compose.yml', 'all compose files']],
    ['locate', 'grep', 'xargs']),
  c('locate', 'Search', 'Find files by name using a prebuilt index', 'locate PATTERN', [['-i', 'ignore case'], ['updatedb', '(run as root to refresh the index)']], [['locate sshd_config', 'instant lookup']], ['find']),
  c('grep', 'Search', 'Search text with patterns', 'grep [options] PATTERN [FILE…]',
    [['-i', 'ignore case'], ['-r', 'recursive'], ['-n', 'line numbers'], ['-v', 'invert match'], ['-E', 'extended regex'], ['-w', 'whole words'], ['-l', 'only file names'], ['-C N', 'N lines of context'], ['-o', 'only the matching part']],
    [['grep -rn "listen" /etc/nginx/', 'find a directive in configs'], ['grep -v "^#" file | grep -v "^$"', 'strip comments and blank lines'], ['grep -i "error" /var/log/syslog | tail', 'recent errors'], ['ps aux | grep [n]ginx', 'process grep without matching itself']],
    ['rg', 'sed', 'awk']),
  c('rg', 'Search', 'ripgrep — very fast recursive grep that respects .gitignore', 'rg [options] PATTERN [path]', [['-i', 'ignore case'], ['-l', 'files only'], ['-t py', 'only a file type'], ['--hidden', 'search hidden files'], ['-uu', 'no ignore rules']],
    [['rg -n "TODO"', 'find TODOs'], ['rg -l password /etc 2>/dev/null', 'which configs mention password']], ['grep']),

  // ------------------------------------------------------------ Text processing
  c('sed', 'Text', 'Stream editor: find/replace and line editing', "sed [options] 'SCRIPT' [FILE]",
    [['-i', 'edit in place (use -i.bak to keep a backup)'], ['-n', 'quiet; print only with p'], ['-E', 'extended regex'], ['s/a/b/g', 'replace all a with b']],
    [["sed -i.bak 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config", 'disable SSH password logins (keeps a .bak)'], ["sed -n '10,20p' file", 'print lines 10–20'], ["sed '/^\\s*#/d;/^\\s*$/d' file", 'drop comments and blank lines']],
    ['awk', 'grep', 'tr']),
  c('awk', 'Text', 'Pattern-scanning and column processing language', "awk [-F sep] 'PROGRAM' [FILE]", [['-F', 'field separator'], ['$1, $NF', 'first / last field'], ['NR', 'line number']],
    [["df -h | awk '$5+0 > 80 {print $6, $5}'", 'filesystems over 80% full'], ["awk -F: '{print $1}' /etc/passwd", 'list usernames'], ["awk '{s+=$1} END {print s}' nums.txt", 'sum a column']],
    ['cut', 'sed']),
  c('cut', 'Text', 'Cut columns out of lines', 'cut -d DELIM -f FIELDS [FILE]', [['-d', 'delimiter'], ['-f', 'fields, e.g. 1,3 or 2-'], ['-c', 'character positions']], [["cut -d: -f1,7 /etc/passwd", 'users and their shells']], ['awk']),
  c('sort', 'Text', 'Sort lines', 'sort [options] [FILE]', [['-n', 'numeric'], ['-h', 'human sizes (1K 2M 3G)'], ['-r', 'reverse'], ['-k N', 'sort by column N'], ['-u', 'unique'], ['-t', 'field separator']],
    [['du -sh * | sort -h', 'by size'], ['sort -t, -k3 -n data.csv', 'CSV by 3rd column']], ['uniq']),
  c('uniq', 'Text', 'Collapse or count repeated lines (input must be sorted)', 'uniq [options]', [['-c', 'prefix counts'], ['-d', 'only duplicates']],
    [["awk '{print $1}' access.log | sort | uniq -c | sort -rn | head", 'top client IPs in an nginx log']], ['sort']),
  c('wc', 'Text', 'Count lines, words, bytes', 'wc [-lwc] [FILE]', [['-l', 'lines'], ['-w', 'words'], ['-c', 'bytes']], [['docker ps -q | wc -l', 'number of running containers']], []),
  c('tr', 'Text', 'Translate or delete characters', 'tr SET1 [SET2]', [['-d', 'delete characters'], ['-s', 'squeeze repeats']], [["tr -d '\\r' < win.txt > unix.txt", 'convert CRLF to LF'], ["head -c 32 /dev/urandom | base64 | tr -d '/+='", 'random password']], ['sed']),
  c('jq', 'Text', 'Query and transform JSON', "jq [options] 'FILTER' [FILE]", [['-r', 'raw strings (no quotes)'], ['-c', 'compact'], ['.key', 'select field'], ['.[]', 'iterate array'], ['select(cond)', 'filter']],
    [["docker inspect nginx | jq '.[0].NetworkSettings.Networks'", 'container networks'], ["curl -s api/json | jq -r '.items[].name'", 'extract names']], ['yq']),
  c('diff', 'Text', 'Compare files line by line', 'diff [options] A B', [['-u', 'unified format'], ['-r', 'recursive'], ['--color', 'colour']],
    [['diff -u nginx.conf.bak nginx.conf', 'what did I change?'], ['diff <(ssh a cat /etc/hosts) /etc/hosts', 'compare with another host']], ['cmp']),
  c('tee', 'Text', 'Copy stdin to files and stdout', 'tee [-a] FILE', [['-a', 'append']], [['echo "1.2.3.4 nas" | sudo tee -a /etc/hosts', 'append to a root-owned file']], []),
  c('xargs', 'Text', 'Build command lines from input', 'xargs [options] CMD', [['-0', 'NUL-separated input (pair with find -print0)'], ['-n N', 'N args per call'], ['-P N', 'run N in parallel'], ['-I {}', 'placeholder']],
    [['find . -name "*.jpg" -print0 | xargs -0 -P4 -n1 jpegoptim', 'parallel processing'], ['docker ps -aq | xargs docker inspect', 'inspect all containers']], ['find']),

  // ------------------------------------------------------------ Permissions & users
  c('chmod', 'Permissions', 'Change file permissions', 'chmod [options] MODE FILE…', [['-R', 'recursive'], ['755', 'rwx r-x r-x'], ['644', 'rw- r-- r--'], ['600', 'rw- --- ---'], ['u+x', 'add execute for owner']],
    [['chmod 600 ~/.ssh/authorized_keys', 'SSH requires this'], ['chmod +x script.sh', 'make executable'], ['find dir -type d -exec chmod 755 {} +', 'dirs 755 only']], ['chown', 'umask'], 'Never run `chmod -R 777` — it breaks SSH, sudo and security.'),
  c('chown', 'Permissions', 'Change file owner and group', 'chown [options] USER[:GROUP] FILE…', [['-R', 'recursive'], ['-h', 'change the link itself']],
    [['sudo chown -R 1000:1000 ./data', 'fix volume ownership for a container running as uid 1000'], ['sudo chown www-data: /var/www -R', 'web root to www-data']], ['chmod', 'id']),
  c('sudo', 'Users', 'Run a command as another user (root by default)', 'sudo [options] COMMAND', [['-i', 'login shell as root'], ['-u USER', 'as another user'], ['-n', 'non-interactive (fail instead of asking for a password)'], ['-l', 'list what you may run'], ['-k', 'forget cached credentials']],
    [['sudo -i', 'root shell'], ['sudo !!', 'repeat the last command with sudo'], ['sudo -u postgres psql', 'run as postgres']], ['visudo', 'su']),
  c('visudo', 'Users', 'Safely edit sudoers (syntax checked)', 'visudo [-f file]', [['-f /etc/sudoers.d/NAME', 'edit a drop-in file'], ['-c', 'check syntax only']],
    [['sudo visudo -f /etc/sudoers.d/webssh', 'e.g. add: alice ALL=(ALL) NOPASSWD: /usr/bin/systemctl']], ['sudo']),
  c('useradd', 'Users', 'Create a user', 'useradd [options] NAME', [['-m', 'create home dir'], ['-s /bin/bash', 'login shell'], ['-G group1,group2', 'supplementary groups'], ['-r', 'system user']],
    [['sudo useradd -m -s /bin/bash -G sudo alice', 'new admin user (Debian/Ubuntu)'], ['sudo adduser alice', 'interactive (Debian)']], ['usermod', 'passwd', 'userdel']),
  c('usermod', 'Users', 'Modify a user account', 'usermod [options] USER', [['-aG GROUP', 'append to a group (keep -a!)'], ['-L / -U', 'lock / unlock'], ['-s SHELL', 'change shell']],
    [['sudo usermod -aG docker $USER', 'use docker without sudo (re-login needed)']], ['groups', 'id']),
  c('passwd', 'Users', 'Change a user password', 'passwd [USER]', [['-l', 'lock'], ['-u', 'unlock'], ['-e', 'expire (force change at next login)'], ['-S', 'status']], [['sudo passwd alice', 'set alice\'s password']], ['chage']),
  c('id', 'Users', 'Show user and group IDs', 'id [USER]', [], [['id', 'my uid, gid and groups'], ['id -u', 'just my uid (handy for PUID in compose)']], ['groups', 'whoami']),
  c('who', 'Users', 'Who is logged in', 'who [options]', [['-a', 'all info'], ['-b', 'last boot time']], [['who', 'current sessions'], ['last -n 20', 'recent logins']], ['w', 'last']),
  c('last', 'Users', 'Login history', 'last [options] [USER]', [['-n N', 'last N entries'], ['-i', 'show IPs']], [['last -ai | head -20', 'recent logins with IPs'], ['lastb | head', 'failed logins (root)']], ['who']),

  // ------------------------------------------------------------ Processes
  c('ps', 'Processes', 'Snapshot of running processes', 'ps [options]', [['aux', 'all processes, BSD style'], ['-ef', 'all processes, full format'], ['--sort=-%mem', 'sort by memory'], ['-o', 'custom columns']],
    [['ps aux --sort=-%cpu | head', 'top CPU users'], ['ps -eo pid,user,%mem,cmd --sort=-%mem | head', 'top memory users'], ['ps -fp 1234', 'details for PID 1234']], ['top', 'htop', 'pgrep']),
  c('top', 'Processes', 'Live process monitor', 'top [options]', [['-b -n1', 'batch mode, one snapshot'], ['-u USER', 'one user'], ['M / P', '(keys) sort by memory / CPU'], ['1', '(key) per-CPU view'], ['k', '(key) kill']], [['top -b -n1 | head -20', 'scriptable snapshot']], ['htop', 'btop']),
  c('htop', 'Processes', 'Interactive process viewer', 'htop [options]', [['-u USER', 'filter by user'], ['F4', '(key) filter'], ['F5', '(key) tree view'], ['F9', '(key) kill'], ['F6', '(key) sort']], [['htop', 'start it']], ['top', 'btop']),
  c('kill', 'Processes', 'Send a signal to a process', 'kill [-SIGNAL] PID…', [['-15 / -TERM', 'ask nicely (default)'], ['-9 / -KILL', 'force kill'], ['-HUP', 'reload config (many daemons)'], ['-l', 'list signals']],
    [['kill 1234', 'terminate'], ['kill -9 1234', 'force (last resort)'], ['kill -HUP $(pidof nginx)', 'reload nginx']], ['pkill', 'killall']),
  c('pkill', 'Processes', 'Signal processes by name', 'pkill [options] PATTERN', [['-f', 'match the full command line'], ['-u USER', 'by user'], ['-9', 'force']], [['pkill -f "python app.py"', 'stop a script']], ['pgrep', 'kill']),
  c('pgrep', 'Processes', 'Find PIDs by name', 'pgrep [options] PATTERN', [['-a', 'show command line'], ['-f', 'match full command line'], ['-u USER', 'by user']], [['pgrep -a ssh', 'all ssh processes']], ['pkill', 'ps']),
  c('nohup', 'Processes', 'Run a command immune to hangups', 'nohup CMD &', [], [['nohup ./backup.sh > backup.log 2>&1 &', 'keeps running after you disconnect (tmux is better)']], ['tmux', 'screen']),
  c('lsof', 'Processes', 'List open files and the processes using them', 'lsof [options]', [['-i :PORT', 'who uses a port'], ['-p PID', 'files of a process'], ['+D DIR', 'who has files open under a dir'], ['-nP', 'no DNS/port name lookups']],
    [['sudo lsof -i :443 -nP', 'what is listening on 443'], ['sudo lsof +D /mnt/usb', 'why can\'t I unmount?'], ['sudo lsof | grep deleted', 'deleted files still holding disk space']], ['ss', 'fuser']),

  // ------------------------------------------------------------ System info
  c('uname', 'System', 'Kernel and architecture info', 'uname [-a]', [['-a', 'everything'], ['-r', 'kernel release'], ['-m', 'architecture']], [['uname -a', 'kernel, hostname, arch']], ['hostnamectl']),
  c('hostnamectl', 'System', 'Show or set the hostname', 'hostnamectl [set-hostname NAME]', [], [['hostnamectl', 'OS, kernel, hardware'], ['sudo hostnamectl set-hostname nas01', 'rename the machine']], ['uname']),
  c('uptime', 'System', 'How long the system has been running, load averages', 'uptime [-p]', [['-p', 'pretty'], ['-s', 'boot time']], [['uptime', 'load 1/5/15 min — compare with nproc']], ['w', 'nproc']),
  c('free', 'System', 'Memory usage', 'free [-h]', [['-h', 'human sizes'], ['-s N', 'repeat every N seconds']], [['free -h', '"available" is what matters, not "free"']], ['vmstat', 'top']),
  c('df', 'Disks', 'Filesystem space usage', 'df [options] [path]', [['-h', 'human sizes'], ['-T', 'filesystem type'], ['-i', 'inode usage'], ['-x tmpfs', 'exclude a type']],
    [['df -hT -x tmpfs -x devtmpfs', 'real filesystems only'], ['df -i', 'out of inodes even though space is free?']], ['du', 'lsblk']),
  c('lscpu', 'Hardware', 'CPU details', 'lscpu', [], [['lscpu | grep -E "Model name|Socket|Thread|NUMA"', 'key CPU facts']], ['nproc']),
  c('nproc', 'Hardware', 'Number of CPU cores', 'nproc', [], [['nproc', 'compare with load average']], ['lscpu']),
  c('lspci', 'Hardware', 'List PCI devices', 'lspci [options]', [['-k', 'kernel driver in use'], ['-nn', 'vendor:device IDs'], ['-v', 'verbose']], [['lspci -k | grep -A3 -i vga', 'GPU and its driver'], ['lspci -nn | grep -i ethernet', 'NIC model for driver lookup']], ['lsusb']),
  c('lsusb', 'Hardware', 'List USB devices', 'lsusb [-t]', [['-t', 'tree view']], [['lsusb', 'is my Zigbee stick detected?']], ['lspci', 'dmesg']),
  c('dmesg', 'Hardware', 'Kernel ring buffer (hardware and driver messages)', 'dmesg [options]', [['-T', 'human timestamps'], ['-w', 'follow'], ['-l err,warn', 'only errors/warnings']],
    [['sudo dmesg -T -l err,warn | tail -30', 'recent kernel problems'], ['sudo dmesg -Tw', 'watch while plugging in a device']], ['journalctl']),
  c('sensors', 'Hardware', 'Temperatures, fans, voltages (lm-sensors)', 'sensors', [['sensors-detect', '(run once as root to set up)']], [['watch -n2 sensors', 'live temperatures']], ['nvidia-smi']),
  c('nvidia-smi', 'Hardware', 'NVIDIA GPU status', 'nvidia-smi [options]', [['-l N', 'refresh every N s'], ['--query-gpu=...', 'scriptable query']], [['nvidia-smi', 'utilisation, VRAM, processes'], ['watch -n1 nvidia-smi', 'live view during transcodes']], ['sensors']),
  c('smartctl', 'Disks', 'Disk health (S.M.A.R.T.)', 'smartctl [options] DEVICE', [['-H', 'overall health'], ['-a', 'all attributes'], ['-t short|long', 'start a self-test'], ['-l selftest', 'self-test results']],
    [['sudo smartctl -H /dev/sda', 'PASSED or FAILED'], ['sudo smartctl -a /dev/nvme0', 'NVMe wear and errors'], ['sudo smartctl -a /dev/sda | grep -Ei "realloc|pending|uncorrect"', 'early warning attributes']], ['lsblk']),

  // ------------------------------------------------------------ Disks & storage
  c('lsblk', 'Disks', 'List block devices (disks, partitions)', 'lsblk [options]', [['-f', 'filesystems, labels, UUIDs'], ['-o NAME,SIZE,MODEL,SERIAL', 'custom columns'], ['-d', 'disks only']],
    [['lsblk -f', 'which partition is which'], ['lsblk -do NAME,SIZE,MODEL,SERIAL,ROTA', 'disk inventory (ROTA=1 → HDD)']], ['blkid', 'df', 'fdisk']),
  c('blkid', 'Disks', 'Show UUIDs and filesystem types', 'blkid [device]', [], [['sudo blkid', 'UUIDs for /etc/fstab']], ['lsblk']),
  c('mount', 'Disks', 'Mount a filesystem', 'mount [options] DEVICE DIR', [['-t TYPE', 'filesystem type'], ['-o ro,noatime', 'options'], ['-a', 'mount everything in fstab'], ['--bind', 'bind mount']],
    [['sudo mount /dev/sdb1 /mnt/usb', 'mount a USB disk'], ['sudo mount -a', 'test /etc/fstab after editing'], ['sudo mount -t nfs nas:/export/media /mnt/media', 'NFS share'], ['sudo mount -t cifs //nas/share /mnt/share -o username=me', 'SMB share']],
    ['umount', 'findmnt', 'lsblk']),
  c('umount', 'Disks', 'Unmount a filesystem', 'umount [options] DIR|DEVICE', [['-l', 'lazy unmount'], ['-f', 'force (NFS)']], [['sudo umount /mnt/usb', 'unmount'], ['sudo lsof +D /mnt/usb', 'if "target is busy"']], ['mount']),
  c('findmnt', 'Disks', 'Show mounted filesystems as a tree', 'findmnt [options]', [['-t TYPE', 'filter type'], ['--verify', 'check /etc/fstab']], [['findmnt -t ext4,xfs,zfs,nfs4', 'only interesting mounts'], ['sudo findmnt --verify', 'validate fstab before reboot']], ['mount']),
  c('fdisk', 'Disks', 'Partition table editor (MBR/GPT)', 'fdisk [options] DEVICE', [['-l', 'list partitions (safe)']], [['sudo fdisk -l', 'list all disks']], ['parted', 'lsblk'], 'Writing a partition table destroys data. Check the device with lsblk first.'),
  c('mkfs', 'Disks', 'Create a filesystem', 'mkfs.TYPE [options] DEVICE', [['mkfs.ext4 -L label', 'ext4 with label'], ['mkfs.xfs', 'XFS']], [['sudo mkfs.ext4 -L backup /dev/sdX1', 'format a partition (double-check X!)']], ['lsblk', 'wipefs'], 'Erases the target. Use lsblk -f to be absolutely sure of the device.'),
  c('rsync', 'Transfer', 'Fast, incremental file sync (local or over SSH)', 'rsync [options] SRC DEST',
    [['-a', 'archive (recursive, perms, times, links)'], ['-v', 'verbose'], ['-h', 'human'], ['-P', 'progress + resume partial'], ['-z', 'compress'], ['--delete', 'mirror: delete extras in DEST'], ['-n', 'dry run'], ['-e "ssh -p 2222"', 'custom ssh']],
    [['rsync -avhP ~/photos/ nas:/tank/photos/', 'trailing slashes matter: copy contents'], ['rsync -avhn --delete src/ dst/', 'preview a mirror before running it'], ['rsync -aHAX --info=progress2 /old/ /new/', 'migrate a disk keeping hardlinks/ACLs/xattrs']],
    ['scp', 'rclone'], '`--delete` removes files in the destination that are not in the source — always try with -n first.'),
  c('dd', 'Disks', 'Low-level copy (images, disks)', 'dd if=SRC of=DEST [bs=4M] [status=progress]', [['if=', 'input'], ['of=', 'output'], ['bs=4M', 'block size'], ['status=progress', 'show progress'], ['conv=fsync', 'flush at end']],
    [['sudo dd if=debian.iso of=/dev/sdX bs=4M status=progress conv=fsync', 'write a bootable USB'], ['sudo dd if=/dev/sda of=/mnt/backup/sda.img bs=4M status=progress', 'image a disk']],
    ['lsblk'], 'One wrong of= destroys a disk. Nicknamed "disk destroyer" for a reason.'),

  // ------------------------------------------------------------ ZFS / RAID / LVM
  c('zpool', 'ZFS & RAID', 'Manage ZFS storage pools', 'zpool COMMAND [args]', [['status [-x]', 'health (-x: only problems)'], ['list', 'capacity'], ['scrub POOL', 'verify all data'], ['iostat -v 2', 'live I/O'], ['replace POOL OLD NEW', 'swap a failed disk'], ['import / export', 'move pools between hosts']],
    [['zpool status -x', '"all pools are healthy"?'], ['sudo zpool scrub tank', 'start a scrub (monthly is typical)'], ['zpool list -v', 'per-vdev usage']], ['zfs'], '`zpool destroy` and `labelclear` are irreversible.'),
  c('zfs', 'ZFS & RAID', 'Manage ZFS datasets and snapshots', 'zfs COMMAND [args]', [['list [-t snapshot]', 'datasets / snapshots'], ['snapshot DS@name', 'create snapshot'], ['rollback DS@name', 'revert to snapshot'], ['send / receive', 'replicate'], ['get compressratio', 'properties'], ['set compression=zstd DS', 'tune']],
    [['zfs list -o name,used,avail,refer,mountpoint', 'overview'], ['sudo zfs snapshot -r tank/docker@before-upgrade', 'snapshot before an upgrade'], ['zfs list -t snapshot -o name,used,creation -s creation | tail', 'latest snapshots'], ['sudo zfs send -R tank/data@snap | ssh backup sudo zfs recv -F pool/data', 'replicate to another box']],
    ['zpool']),
  c('mdadm', 'ZFS & RAID', 'Linux software RAID', 'mdadm [mode] [options]', [['--detail /dev/md0', 'array status'], ['--manage /dev/md0 --add /dev/sdX', 'add disk'], ['--fail / --remove', 'replace a disk']],
    [['cat /proc/mdstat', 'quick RAID status / rebuild progress'], ['sudo mdadm --detail /dev/md0', 'full detail']], ['lsblk']),
  c('lvs', 'ZFS & RAID', 'LVM logical volumes (also pvs, vgs)', 'lvs | vgs | pvs', [], [['sudo lvs; sudo vgs; sudo pvs', 'LVM overview'], ['sudo lvextend -r -L +20G /dev/vg0/root', 'grow a volume and its filesystem']], ['lsblk']),
  c('btrfs', 'ZFS & RAID', 'Manage Btrfs filesystems', 'btrfs COMMAND [args]', [['filesystem usage /', 'space'], ['subvolume list /', 'subvolumes'], ['scrub start /', 'verify'], ['device stats /', 'error counters']],
    [['sudo btrfs filesystem usage /', 'real space usage'], ['sudo btrfs scrub start -B /mnt/data', 'scrub in foreground']], []),

  // ------------------------------------------------------------ Networking
  c('ip', 'Network', 'Show/manage addresses, routes, links (iproute2)', 'ip [OBJECT] [COMMAND]', [['a / addr', 'addresses'], ['r / route', 'routing table'], ['link', 'interfaces'], ['neigh', 'ARP/neighbour table'], ['-br', 'brief output'], ['-c', 'colour']],
    [['ip -br -c a', 'compact interface/IP overview'], ['ip r', 'default gateway'], ['ip route get 1.1.1.1', 'which interface is used to reach a host'], ['sudo ip addr add 192.168.1.50/24 dev eth0', 'temporary extra IP']],
    ['ss', 'nmcli', 'ping']),
  c('ss', 'Network', 'Socket statistics — what is listening / connected', 'ss [options]', [['-t / -u', 'TCP / UDP'], ['-l', 'listening'], ['-n', 'numeric'], ['-p', 'process (needs root)'], ['-a', 'all']],
    [['sudo ss -tulpn', 'every listening port and its process'], ['ss -tn state established', 'active TCP connections'], ["sudo ss -tlpn 'sport = :443'", 'who has port 443']], ['lsof', 'netstat']),
  c('ping', 'Network', 'Check reachability and latency', 'ping [options] HOST', [['-c N', 'send N packets'], ['-i 0.2', 'interval'], ['-4 / -6', 'force IPv4/IPv6'], ['-s SIZE', 'payload size (MTU tests)']],
    [['ping -c 4 1.1.1.1', 'internet up?'], ['ping -c 3 nas.lan', 'local DNS + host up?'], ['ping -M do -s 1472 -c 3 1.1.1.1', 'path MTU test (1500)']], ['mtr', 'traceroute']),
  c('mtr', 'Network', 'Traceroute + ping combined, live', 'mtr [options] HOST', [['-r -c 50', 'report mode, 50 cycles'], ['-n', 'no DNS'], ['-T -P 443', 'use TCP to port 443']], [['mtr -rwc 50 1.1.1.1', 'find where packet loss starts']], ['ping', 'traceroute']),
  c('traceroute', 'Network', 'Show the network path to a host', 'traceroute [options] HOST', [['-n', 'no DNS'], ['-T', 'TCP SYN'], ['-I', 'ICMP']], [['traceroute -n 8.8.8.8', 'path to Google DNS']], ['mtr']),
  c('dig', 'Network', 'DNS lookup', 'dig [@server] NAME [TYPE]', [['+short', 'just the answer'], ['@1.1.1.1', 'ask a specific resolver'], ['-x IP', 'reverse lookup'], ['MX/TXT/AAAA/NS', 'record type']],
    [['dig +short webssh.lucafchala.com', 'what does it resolve to?'], ['dig @192.168.1.2 nas.lan', 'test your Pi-hole/AdGuard'], ['dig +trace example.com', 'full delegation path']], ['nslookup', 'resolvectl']),
  c('resolvectl', 'Network', 'systemd-resolved DNS status and cache', 'resolvectl [command]', [['status', 'DNS servers per link'], ['query NAME', 'resolve via resolved'], ['flush-caches', 'clear DNS cache']], [['resolvectl status', 'which DNS servers am I using?']], ['dig']),
  c('curl', 'Network', 'Transfer data from/to URLs', 'curl [options] URL', [['-I', 'headers only'], ['-L', 'follow redirects'], ['-o FILE / -O', 'save output'], ['-s', 'silent'], ['-k', 'ignore TLS errors (testing only)'], ['-v', 'verbose (TLS + headers)'], ['-X POST -d', 'send data'], ['--resolve host:443:IP', 'test a vhost on a specific IP']],
    [['curl -I https://webssh.lucafchala.com', 'status and headers'], ['curl -sv https://site 2>&1 | grep -i expire', 'certificate expiry'], ['curl -s ifconfig.me', 'your public IP'], ['curl -fsSL URL -o file', 'robust download']],
    ['wget']),
  c('wget', 'Network', 'Download files', 'wget [options] URL', [['-O FILE', 'output name'], ['-c', 'resume'], ['-q', 'quiet'], ['--spider', 'check only']], [['wget -c https://example.com/big.iso', 'resumable download']], ['curl']),
  c('nmap', 'Network', 'Network scanner', 'nmap [options] TARGET', [['-sn', 'ping scan (host discovery)'], ['-p 1-1000', 'port range'], ['-sV', 'service versions'], ['-O', 'OS detection (root)'], ['--open', 'only open ports']],
    [['nmap -sn 192.168.1.0/24', 'what is on my LAN?'], ['nmap -sV --open 192.168.1.10', 'services on a host']], ['ss', 'arp-scan'], 'Only scan networks you own or are allowed to test.'),
  c('nc', 'Network', 'netcat — raw TCP/UDP tool', 'nc [options] HOST PORT', [['-z', 'scan without sending data'], ['-v', 'verbose'], ['-u', 'UDP'], ['-l', 'listen'], ['-w N', 'timeout']],
    [['nc -zv nas 445', 'is SMB reachable?'], ['nc -l 9000 > file / nc host 9000 < file', 'quick file transfer on the LAN']], ['curl']),
  c('tcpdump', 'Network', 'Capture packets', 'tcpdump [options] [filter]', [['-i IFACE', 'interface (any for all)'], ['-n', 'no DNS'], ['-c N', 'stop after N packets'], ['-w file.pcap', 'write for Wireshark'], ['port 53', 'filter expression']],
    [['sudo tcpdump -ni any port 53 -c 20', 'watch DNS queries'], ['sudo tcpdump -ni eth0 host 192.168.1.20 -w cap.pcap', 'capture one host']], ['ss']),
  c('iperf3', 'Network', 'Measure network throughput', 'iperf3 -s | iperf3 -c SERVER', [['-s', 'server mode'], ['-c HOST', 'client'], ['-R', 'reverse direction'], ['-P N', 'parallel streams'], ['-t N', 'duration']], [['iperf3 -s (on NAS) then iperf3 -c nas -P 4', 'is my 10 GbE really 10 GbE?']], []),
  c('nmcli', 'Network', 'NetworkManager CLI', 'nmcli [OBJECT] [COMMAND]', [['device status', 'interfaces'], ['connection show', 'profiles'], ['con mod NAME ipv4.addresses ...', 'static IP'], ['device wifi list', 'Wi-Fi networks']],
    [['nmcli device status', 'what is connected'], ['sudo nmcli con mod "Wired connection 1" ipv4.method manual ipv4.addresses 192.168.1.50/24 ipv4.gateway 192.168.1.1 ipv4.dns 192.168.1.2 && sudo nmcli con up "Wired connection 1"', 'set a static IP']],
    ['ip']),
  c('wg', 'Network', 'WireGuard VPN tool', 'wg [show|genkey|pubkey]', [['show', 'peers, handshakes, transfer'], ['genkey | tee priv | wg pubkey > pub', 'make a keypair'], ['wg-quick up wg0', 'bring an interface up']],
    [['sudo wg show', 'are peers handshaking?'], ['sudo systemctl enable --now wg-quick@wg0', 'start at boot']], ['tailscale']),
  c('tailscale', 'Network', 'Tailscale mesh VPN', 'tailscale [command]', [['status', 'peers'], ['up --ssh', 'connect, enable Tailscale SSH'], ['ip -4', 'this node\'s tailnet IP'], ['ping HOST', 'test a peer']], [['tailscale status', 'who is online']], ['wg']),

  // ------------------------------------------------------------ Firewall & security
  c('ufw', 'Firewall', 'Uncomplicated Firewall (Ubuntu/Debian)', 'ufw [command]', [['status verbose', 'rules and defaults'], ['allow 22/tcp', 'open a port'], ['allow from 192.168.1.0/24 to any port 22', 'LAN only'], ['deny / delete', 'remove rules'], ['enable', 'turn on']],
    [['sudo ufw allow OpenSSH && sudo ufw enable', 'enable without locking yourself out'], ['sudo ufw status numbered', 'rule numbers for deleting']],
    ['iptables', 'nft'], 'Always allow your SSH port BEFORE `ufw enable`.'),
  c('nft', 'Firewall', 'nftables firewall', 'nft [command]', [['list ruleset', 'show everything'], ['add rule ...', 'add rules']], [['sudo nft list ruleset', 'current firewall']], ['iptables', 'ufw'], '`nft flush ruleset` removes all rules — including the ones keeping you connected.'),
  c('iptables', 'Firewall', 'Legacy netfilter firewall', 'iptables [options]', [['-L -n -v', 'list rules with counters'], ['-t nat -L -n', 'NAT rules (Docker!)'], ['-S', 'rules as commands']], [['sudo iptables -L -n -v --line-numbers', 'inspect'], ['sudo iptables -t nat -L DOCKER -n', 'docker port mappings']], ['nft', 'ufw']),
  c('fail2ban-client', 'Security', 'Inspect and control fail2ban', 'fail2ban-client [command]', [['status', 'jails'], ['status sshd', 'banned IPs for a jail'], ['set JAIL unbanip IP', 'unban']],
    [['sudo fail2ban-client status sshd', 'who is banned'], ['sudo fail2ban-client set webssh unbanip 1.2.3.4', 'unban yourself']], ['cscli']),
  c('cscli', 'Security', 'CrowdSec CLI', 'cscli [command]', [['decisions list', 'current bans'], ['alerts list', 'recent detections'], ['decisions delete --ip IP', 'unban'], ['collections install', 'add parsers/scenarios']], [['sudo cscli decisions list', 'active bans'], ['sudo cscli metrics', 'what is being parsed']], ['fail2ban-client']),
  c('openssl', 'Security', 'TLS/crypto toolkit', 'openssl COMMAND [options]', [['s_client -connect host:443', 'inspect a TLS server'], ['x509 -noout -dates -subject', 'certificate info'], ['rand -base64 32', 'random secret']],
    [['echo | openssl s_client -connect webssh.lucafchala.com:443 -servername webssh.lucafchala.com 2>/dev/null | openssl x509 -noout -dates -issuer', 'cert issuer and expiry'], ['openssl rand -base64 32', 'generate a MASTER_KEY']],
    ['certbot', 'curl']),
  c('certbot', 'Security', 'Let\'s Encrypt certificates', 'certbot [command]', [['certificates', 'list certs'], ['renew --dry-run', 'test renewal'], ['certonly --dns-cloudflare', 'DNS challenge']], [['sudo certbot certificates', 'what expires when'], ['sudo certbot renew --dry-run', 'will renewal work?']], ['openssl']),

  // ------------------------------------------------------------ SSH & transfer
  c('ssh', 'SSH', 'OpenSSH client', 'ssh [options] [user@]host [command]', [['-p PORT', 'port'], ['-i KEY', 'identity file'], ['-J jump', 'via a jump host'], ['-L 8080:localhost:80', 'local port forward'], ['-R', 'remote forward'], ['-D 1080', 'SOCKS proxy'], ['-v', 'debug']],
    [['ssh -J bastion admin@10.0.0.5', 'hop through a bastion'], ['ssh -L 8006:localhost:8006 pve', 'reach the Proxmox UI through SSH'], ['ssh -v host', 'debug auth problems']], ['ssh-keygen', 'scp', 'rsync']),
  c('ssh-keygen', 'SSH', 'Create and manage SSH keys', 'ssh-keygen [options]', [['-t ed25519', 'key type (recommended)'], ['-C comment', 'label'], ['-f FILE', 'output'], ['-R host', 'remove a host from known_hosts'], ['-lf FILE', 'show fingerprint'], ['-p', 'change passphrase']],
    [['ssh-keygen -t ed25519 -C "me@laptop"', 'new key'], ['ssh-keygen -R 192.168.1.10', 'fix "REMOTE HOST IDENTIFICATION HAS CHANGED" after a reinstall'], ['ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub', 'this server\'s host key fingerprint (compare with WebSSH)']],
    ['ssh-copy-id']),
  c('ssh-copy-id', 'SSH', 'Install your public key on a server', 'ssh-copy-id [-i KEY] user@host', [['-i FILE', 'which key'], ['-p PORT', 'port']], [['ssh-copy-id -i ~/.ssh/id_ed25519.pub admin@nas', 'enable key login']], ['ssh-keygen']),
  c('scp', 'SSH', 'Copy files over SSH', 'scp [options] SRC DEST', [['-r', 'recursive'], ['-P PORT', 'port (capital P)'], ['-J jump', 'via jump host']], [['scp backup.tar.gz nas:/tank/backups/', 'upload'], ['scp -r pi:~/config ./', 'download a folder']], ['rsync', 'sftp']),
  c('sshd', 'SSH', 'OpenSSH server: config check and hardening', 'sshd -t | sshd -T', [['-t', 'test config syntax'], ['-T', 'print effective config']],
    [['sudo sshd -t && sudo systemctl reload ssh', 'validate before reloading'], ['sudo sshd -T | grep -Ei "passwordauth|permitroot|pubkey"', 'effective auth settings']], ['ssh']),

  // ------------------------------------------------------------ Services & logs
  c('systemctl', 'Services', 'Control systemd services', 'systemctl [command] [unit]', [['status UNIT', 'state + recent logs'], ['start/stop/restart UNIT', 'control'], ['reload UNIT', 'reload config'], ['enable --now UNIT', 'start now and at boot'], ['disable UNIT', 'don\'t start at boot'], ['--failed', 'failed units'], ['list-timers', 'scheduled timers'], ['daemon-reload', 'after editing unit files'], ['edit UNIT', 'create an override']],
    [['systemctl --failed', 'what broke?'], ['sudo systemctl restart docker', 'restart a service'], ['systemctl list-units --type=service --state=running', 'running services'], ['sudo systemctl edit --full nginx', 'edit a unit']],
    ['journalctl', 'service']),
  c('journalctl', 'Services', 'Query the systemd journal (logs)', 'journalctl [options]', [['-u UNIT', 'one service'], ['-f', 'follow'], ['-n N', 'last N lines'], ['-b', 'this boot (-b -1: previous boot)'], ['-p err', 'errors and worse'], ['--since "1 hour ago"', 'time window'], ['-k', 'kernel only'], ['--disk-usage / --vacuum-size=500M', 'manage journal size']],
    [['journalctl -u nginx -f', 'follow nginx logs'], ['journalctl -b -1 -p err', 'errors from the boot before a crash'], ['journalctl --since "10 min ago"', 'everything recent'], ['sudo journalctl --vacuum-size=500M', 'shrink the journal']],
    ['systemctl', 'dmesg']),
  c('crontab', 'Scheduling', 'Per-user scheduled jobs', 'crontab [-e|-l]', [['-e', 'edit'], ['-l', 'list'], ['-r', 'remove ALL jobs (careful)'], ['m h dom mon dow cmd', 'line format']],
    [['crontab -e', 'add e.g.: 0 3 * * * /home/me/backup.sh >> /var/log/backup.log 2>&1'], ['crontab -l', 'list my jobs']], ['systemctl list-timers']),
  c('timedatectl', 'System', 'Time, timezone and NTP', 'timedatectl [command]', [['status', 'time + NTP sync'], ['set-timezone Europe/Lisbon', 'timezone'], ['list-timezones', 'all zones']], [['timedatectl', 'is NTP synchronised? (TOTP needs correct time!)']], ['date']),
  c('reboot', 'Power', 'Restart the machine', 'sudo reboot', [], [['sudo reboot', 'restart now'], ['sudo shutdown -r +5 "Kernel update"', 'restart in 5 minutes with a message'], ['sudo shutdown -c', 'cancel a scheduled shutdown']], ['shutdown'], 'You will lose your session — make sure the host comes back (and you can reach it remotely).'),
  c('shutdown', 'Power', 'Power off or reboot (scheduled)', 'shutdown [options] [time] [message]', [['-h now', 'halt/power off now'], ['-r', 'reboot'], ['+N', 'in N minutes'], ['-c', 'cancel']], [['sudo shutdown -h now', 'power off'], ['sudo shutdown -r 23:00', 'reboot tonight']], ['reboot']),

  // ------------------------------------------------------------ Packages
  c('apt', 'Packages', 'Debian/Ubuntu package manager', 'apt [command]', [['update', 'refresh package lists'], ['upgrade', 'install updates'], ['full-upgrade', 'updates that add/remove packages'], ['install PKG', 'install'], ['remove / purge', 'uninstall'], ['autoremove', 'remove unused deps'], ['list --upgradable', 'pending updates'], ['search / show', 'find / inspect']],
    [['sudo apt update && sudo apt full-upgrade -y', 'patch the system'], ['apt list --upgradable', 'what would be updated'], ['sudo apt install -y unattended-upgrades', 'automatic security updates']],
    ['dpkg']),
  c('dpkg', 'Packages', 'Low-level Debian package tool', 'dpkg [options]', [['-l', 'list installed'], ['-L PKG', 'files in a package'], ['-S FILE', 'which package owns a file'], ['-i FILE.deb', 'install a .deb']], [['dpkg -S /usr/bin/htop', 'who installed this?'], ['dpkg -l | grep linux-image', 'installed kernels']], ['apt']),
  c('dnf', 'Packages', 'Fedora/RHEL/Rocky package manager', 'dnf [command]', [['check-update', 'pending updates'], ['upgrade', 'update'], ['install / remove', 'manage'], ['search / info', 'inspect'], ['history', 'transactions (undo!)']], [['sudo dnf upgrade --refresh', 'patch the system'], ['sudo dnf history undo last', 'roll back the last transaction']], []),
  c('pacman', 'Packages', 'Arch Linux package manager', 'pacman [options]', [['-Syu', 'full system upgrade'], ['-S PKG', 'install'], ['-Rns PKG', 'remove with deps'], ['-Qu', 'pending updates'], ['-Ss TERM', 'search']], [['sudo pacman -Syu', 'update everything']], []),
  c('apk', 'Packages', 'Alpine package manager', 'apk [command]', [['update', 'refresh index'], ['upgrade', 'update'], ['add / del', 'install / remove'], ['search', 'find']], [['apk add --no-cache curl', 'install in a container']], []),
  c('snap', 'Packages', 'Snap packages', 'snap [command]', [['list', 'installed'], ['refresh', 'update'], ['install / remove', 'manage']], [['snap list', 'what snaps are installed']], ['apt']),

  // ------------------------------------------------------------ Containers
  c('docker', 'Containers', 'Docker CLI', 'docker [command]', [['ps [-a]', 'containers (all)'], ['logs -f --tail 100 NAME', 'follow logs'], ['exec -it NAME sh', 'shell inside'], ['restart NAME', 'restart'], ['stats', 'live CPU/memory'], ['images / pull', 'images'], ['inspect NAME', 'full config'], ['system df', 'disk usage'], ['system prune', 'clean unused data']],
    [['docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', 'clean overview'], ['docker logs -f --tail 100 jellyfin', 'follow logs'], ['docker exec -it postgres psql -U postgres', 'DB shell'], ['docker stats --no-stream', 'resource usage snapshot'], ['docker system df -v', 'what uses disk']],
    ['docker compose', 'podman'], '`docker system prune -a --volumes` deletes unused images AND volumes (your data!).'),
  c('docker compose', 'Containers', 'Multi-container apps from docker-compose.yml', 'docker compose [command]', [['up -d', 'create/start in background'], ['down', 'stop and remove containers (keeps volumes)'], ['pull', 'fetch newer images'], ['logs -f [svc]', 'follow logs'], ['ps', 'status'], ['restart svc', 'restart one service'], ['config', 'validate and print merged config'], ['exec svc sh', 'shell']],
    [['docker compose pull && docker compose up -d', 'update a stack'], ['docker compose logs -f --tail 50', 'all logs'], ['docker compose config -q', 'validate the YAML'], ['docker compose down -v', 'tear down INCLUDING volumes (destructive)']],
    ['docker']),
  c('podman', 'Containers', 'Daemonless, rootless Docker-compatible engine', 'podman [command]', [['ps -a', 'containers'], ['generate systemd --new NAME', 'unit file'], ['auto-update', 'update labelled containers']], [['podman ps -a', 'containers'], ['podman logs -f NAME', 'logs']], ['docker']),
  c('kubectl', 'Kubernetes', 'Kubernetes CLI (k3s, k8s, microk8s)', 'kubectl [command]', [['get pods -A', 'all pods'], ['describe pod NAME', 'events and details'], ['logs -f POD [-c ctr]', 'logs'], ['exec -it POD -- sh', 'shell'], ['apply -f FILE', 'deploy'], ['rollout restart deploy/NAME', 'restart a deployment'], ['top pods', 'resource usage']],
    [['kubectl get pods -A -o wide', 'where everything runs'], ['kubectl get events -A --sort-by=.lastTimestamp | tail', 'recent cluster events'], ['kubectl -n media rollout restart deploy/jellyfin', 'restart']],
    ['helm', 'k9s']),
  c('helm', 'Kubernetes', 'Kubernetes package manager', 'helm [command]', [['list -A', 'releases'], ['repo add / update', 'chart repos'], ['upgrade --install', 'deploy/update'], ['rollback REL REV', 'roll back']], [['helm list -A', 'what is installed']], ['kubectl']),

  // ------------------------------------------------------------ Virtualization
  c('qm', 'Virtualization', 'Proxmox VE: manage QEMU VMs', 'qm [command] [vmid]', [['list', 'VMs'], ['start/shutdown/stop VMID', 'power'], ['config VMID', 'config'], ['snapshot VMID NAME', 'snapshot'], ['rollback VMID NAME', 'revert'], ['terminal VMID', 'serial console']],
    [['qm list', 'all VMs and state'], ['qm shutdown 101 && qm start 101', 'clean restart'], ['qm snapshot 101 pre-update', 'snapshot before changes']], ['pct', 'pvesh'], '`qm destroy` deletes the VM and its disks.'),
  c('pct', 'Virtualization', 'Proxmox VE: manage LXC containers', 'pct [command] [ctid]', [['list', 'containers'], ['start/stop CTID', 'power'], ['enter CTID', 'root shell inside'], ['config CTID', 'config'], ['snapshot CTID NAME', 'snapshot']],
    [['pct list', 'all containers'], ['pct enter 200', 'shell in container 200']], ['qm']),
  c('pvesh', 'Virtualization', 'Proxmox VE API from the shell', 'pvesh get PATH', [['get /cluster/resources', 'everything in the cluster'], ['get /nodes', 'nodes'], ['--output-format json', 'JSON']], [['pvesh get /cluster/resources --type vm', 'VMs across the cluster']], ['qm', 'pct']),
  c('virsh', 'Virtualization', 'libvirt / KVM management', 'virsh [command]', [['list --all', 'VMs'], ['start/shutdown NAME', 'power'], ['console NAME', 'serial console'], ['dominfo NAME', 'details'], ['autostart NAME', 'start at boot']], [['virsh list --all', 'all VMs']], []),

  // ------------------------------------------------------------ Archives
  c('tar', 'Archives', 'Create and extract archives', 'tar [options] [archive] [files]', [['-c / -x / -t', 'create / extract / list'], ['-z / -J / --zstd', 'gzip / xz / zstd'], ['-f FILE', 'archive file'], ['-v', 'verbose'], ['-C DIR', 'change directory'], ['--exclude PATTERN', 'skip files']],
    [['tar -czf backup.tar.gz ~/docker', 'compress a folder'], ['tar -xzf backup.tar.gz -C /restore', 'extract somewhere'], ['tar -tzf backup.tar.gz | head', 'peek inside'], ['tar --zstd -cf data.tar.zst data/', 'fast modern compression']],
    ['zip', 'gzip', 'zstd']),
  c('zip', 'Archives', 'Create ZIP archives (unzip to extract)', 'zip [-r] OUT.zip FILES', [['-r', 'recursive'], ['-e', 'encrypt'], ['unzip -l', 'list'], ['unzip -d DIR', 'extract to']], [['zip -r site.zip public/', 'zip a folder'], ['unzip file.zip -d out/', 'extract']], ['tar']),
  c('zstd', 'Archives', 'Fast modern compression', 'zstd [options] FILE', [['-d', 'decompress'], ['-T0', 'all cores'], ['-19', 'max compression']], [['zstd -T0 big.img', 'compress a disk image fast']], ['tar', 'gzip']),

  // ------------------------------------------------------------ Shell & terminal
  c('tmux', 'Shell', 'Terminal multiplexer — sessions survive disconnects', 'tmux [command]', [['new -s NAME', 'new named session'], ['attach -t NAME / a', 'attach'], ['ls', 'list sessions'], ['Ctrl-b d', 'detach'], ['Ctrl-b c / n / p', 'new / next / prev window'], ['Ctrl-b % / "', 'split vertical / horizontal'], ['Ctrl-b [', 'scroll mode (q to exit)']],
    [['tmux new -As main', 'attach to "main", creating it if needed — great as a host startup command'], ['tmux ls', 'running sessions']], ['screen']),
  c('screen', 'Shell', 'GNU screen terminal multiplexer', 'screen [options]', [['-S NAME', 'named session'], ['-r NAME', 'reattach'], ['-ls', 'list'], ['Ctrl-a d', 'detach']], [['screen -S backup', 'start a long job safely'], ['screen -r backup', 'reattach later']], ['tmux']),
  c('history', 'Shell', 'Shell command history', 'history [N]', [['!N', 'run entry N'], ['!!', 'last command'], ['!$', 'last argument of last command'], ['Ctrl-r', 'reverse search']], [['history | grep docker', 'find a past command'], ['sudo !!', 'redo with sudo']], []),
  c('watch', 'Shell', 'Re-run a command periodically', 'watch [options] CMD', [['-n SEC', 'interval'], ['-d', 'highlight changes']], [["watch -n 2 'docker ps'", 'live container status'], ['watch -d -n1 cat /proc/mdstat', 'RAID rebuild progress']], []),
  c('alias', 'Shell', 'Command shortcuts', "alias NAME='COMMAND'", [], [["alias dps='docker ps --format \"table {{.Names}}\\t{{.Status}}\"'", 'add to ~/.bashrc to keep']], []),
  c('env', 'Shell', 'Show or set environment for a command', 'env [VAR=val] [CMD]', [], [['env | sort', 'all variables'], ['env -i bash', 'clean environment']], ['export']),
  c('git', 'Git', 'Version control', 'git [command]', [['status', 'what changed'], ['log --oneline --graph', 'history'], ['diff', 'unstaged changes'], ['pull / push', 'sync'], ['stash', 'park changes'], ['restore FILE', 'discard changes']],
    [['git -C ~/homelab-configs pull', 'update your infra repo'], ['git log --oneline -15', 'recent commits'], ['git diff --stat', 'summary of changes']], []),
];

export const CATEGORIES = [...new Set(COMMANDS.map((c) => c.category))];

export function searchCommands(q: string, limit = 50): CommandHelp[] {
  const query = q.trim().toLowerCase();
  if (!query) return COMMANDS.slice(0, limit);
  const scored: [number, CommandHelp][] = [];
  for (const cmd of COMMANDS) {
    let score = 0;
    const name = cmd.name.toLowerCase();
    if (name === query) score += 100;
    else if (name.startsWith(query)) score += 50;
    else if (name.includes(query)) score += 30;
    if (cmd.summary.toLowerCase().includes(query)) score += 20;
    if (cmd.category.toLowerCase().includes(query)) score += 10;
    for (const [ex, desc] of cmd.examples) if (ex.toLowerCase().includes(query) || desc.toLowerCase().includes(query)) score += 5;
    for (const [opt, desc] of cmd.options) if (opt.toLowerCase().includes(query) || desc.toLowerCase().includes(query)) score += 2;
    if (score) scored.push([score, cmd]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, c]) => c);
}
