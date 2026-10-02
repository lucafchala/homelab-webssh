/**
 * Task-oriented recipes ("how do I …") answered locally — no AI call needed.
 * `keywords` drive the natural-language matcher in search.ts.
 */
export interface Recipe {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  steps: { text: string; command?: string }[];
  note?: string;
}

const r = (id: string, title: string, category: string, keywords: string, steps: { text: string; command?: string }[], note?: string): Recipe => ({
  id,
  title,
  category,
  keywords: keywords.split(/\s+/).filter(Boolean),
  steps,
  note,
});

export const RECIPES: Recipe[] = [
  // ---------------------------------------------------------------- disk space
  r('disk-full', 'Find what is filling up a disk', 'Disks', 'disk full space usage biggest large files folders directories root filling out storage', [
    { text: 'Which filesystem is full?', command: 'df -hT -x tmpfs -x devtmpfs' },
    { text: 'Biggest top-level directories on that filesystem', command: 'sudo du -xh / -d 1 2>/dev/null | sort -h | tail -15' },
    { text: 'Files larger than 1 GB', command: 'sudo find / -xdev -type f -size +1G -exec ls -lh {} + 2>/dev/null' },
    { text: 'Interactive explorer (if installed)', command: 'sudo ncdu -x /' },
  ], 'Usual suspects: /var/lib/docker, /var/log/journal, old kernels, forgotten backups.'),
  r('docker-disk', 'Free up disk space used by Docker', 'Containers', 'docker disk space cleanup prune images volumes build cache reclaim free', [
    { text: 'See what Docker is using', command: 'docker system df' },
    { text: 'Remove stopped containers, unused networks and dangling images', command: 'docker system prune' },
    { text: 'Also remove all unused images (they will be re-pulled when needed)', command: 'docker image prune -a' },
    { text: 'Remove build cache', command: 'docker builder prune' },
  ], 'Avoid `--volumes` unless you are sure: unused volumes can still hold data you care about.'),
  r('journal-size', 'Shrink systemd journal logs', 'Logs', 'journal logs size shrink vacuum clean var log disk space', [
    { text: 'Current journal size', command: 'journalctl --disk-usage' },
    { text: 'Keep only the last 500 MB', command: 'sudo journalctl --vacuum-size=500M' },
    { text: 'Make it permanent: set SystemMaxUse=500M in /etc/systemd/journald.conf, then', command: 'sudo systemctl restart systemd-journald' },
  ]),
  r('deleted-open-files', 'Disk still full after deleting files', 'Disks', 'deleted files still space not freed open handle df du mismatch', [
    { text: 'Find deleted files still held open by a process', command: "sudo lsof -nP +L1 2>/dev/null | grep -i deleted" },
    { text: 'Restart the process that holds them (often a logger or container)', command: 'sudo systemctl restart <service>' },
  ]),

  // ---------------------------------------------------------------- ports & network
  r('port-in-use', 'What is using / listening on a port', 'Network', 'port use using listening listen bound address already in use which process 80 443 8080 who', [
    { text: 'All listening ports with their processes', command: 'sudo ss -tulpn' },
    { text: 'One specific port (e.g. 8080)', command: "sudo ss -tlpn 'sport = :8080'" },
    { text: 'Alternative with lsof', command: 'sudo lsof -nP -i :8080' },
    { text: 'If it is a container', command: "docker ps --format '{{.Names}}\\t{{.Ports}}' | grep 8080" },
  ]),
  r('my-ip', 'Show this machine\'s IP addresses', 'Network', 'ip address my local public lan wan interface show what is', [
    { text: 'LAN addresses (compact)', command: 'ip -br -c a' },
    { text: 'Default gateway / route', command: 'ip r' },
    { text: 'Public IP', command: 'curl -s https://ifconfig.me; echo' },
  ]),
  r('static-ip', 'Set a static IP address', 'Network', 'static ip address set fixed configure netplan networkmanager dhcp reservation', [
    { text: 'NetworkManager systems (Fedora, Ubuntu desktop, many servers)', command: 'sudo nmcli con mod "Wired connection 1" ipv4.method manual ipv4.addresses 192.168.1.50/24 ipv4.gateway 192.168.1.1 ipv4.dns 192.168.1.2 && sudo nmcli con up "Wired connection 1"' },
    { text: 'Ubuntu Server (netplan): edit /etc/netplan/*.yaml, then test with automatic rollback', command: 'sudo netplan try' },
    { text: 'Debian (ifupdown): edit /etc/network/interfaces, then', command: 'sudo systemctl restart networking' },
  ], 'Easiest and safest: keep DHCP on the host and create a DHCP reservation on your router.'),
  r('dns-check', 'Debug DNS resolution', 'Network', 'dns resolve resolution name lookup not resolving pihole adguard nslookup dig domain', [
    { text: 'Which resolvers am I using?', command: 'resolvectl status 2>/dev/null || cat /etc/resolv.conf' },
    { text: 'Resolve through the system', command: 'getent hosts example.com' },
    { text: 'Ask a specific DNS server directly', command: 'dig @192.168.1.2 example.com +short' },
    { text: 'Flush the local cache', command: 'sudo resolvectl flush-caches' },
  ]),
  r('connectivity', 'Is the network / internet working?', 'Network', 'internet down connectivity network not working offline ping gateway reach unreachable', [
    { text: 'Gateway reachable?', command: 'ping -c 3 $(ip r | awk \'/default/ {print $3; exit}\')' },
    { text: 'Internet by IP (bypasses DNS)', command: 'ping -c 3 1.1.1.1' },
    { text: 'Internet by name (tests DNS)', command: 'ping -c 3 cloudflare.com' },
    { text: 'Where does it break?', command: 'mtr -rwc 20 1.1.1.1' },
  ]),
  r('speed-test', 'Measure network speed between two hosts', 'Network', 'network speed bandwidth throughput test iperf slow transfer lan 10g gigabit', [
    { text: 'On the server side', command: 'iperf3 -s' },
    { text: 'On the client side (4 parallel streams)', command: 'iperf3 -c <server-ip> -P 4' },
    { text: 'Reverse direction', command: 'iperf3 -c <server-ip> -R' },
  ]),
  r('scan-lan', 'List devices on the local network', 'Network', 'scan lan network devices hosts discover find who is on my network subnet', [
    { text: 'Ping-scan the subnet', command: 'nmap -sn 192.168.1.0/24' },
    { text: 'Neighbours this host already knows', command: 'ip neigh' },
  ]),
  r('open-port-firewall', 'Open a port in the firewall', 'Firewall', 'open port firewall allow ufw firewalld iptables block blocked incoming', [
    { text: 'UFW (Ubuntu/Debian)', command: 'sudo ufw allow 8080/tcp && sudo ufw status' },
    { text: 'firewalld (Fedora/RHEL/Rocky)', command: 'sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload' },
    { text: 'Only from your LAN (UFW)', command: 'sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp' },
  ], 'With Cloudflare Tunnel you usually do NOT need to open any inbound port on your router.'),

  // ---------------------------------------------------------------- services & logs
  r('service-logs', 'See why a service failed', 'Services', 'service failed failing crash not starting error logs why systemd unit status restart', [
    { text: 'Failed units', command: 'systemctl --failed' },
    { text: 'Status with the last log lines', command: 'systemctl status <service> --no-pager -l' },
    { text: 'Recent logs for that service', command: 'journalctl -u <service> -n 100 --no-pager' },
    { text: 'Follow logs while restarting it', command: 'sudo systemctl restart <service>; journalctl -u <service> -f' },
  ]),
  r('enable-service', 'Start a service now and at boot', 'Services', 'enable start boot autostart service systemd startup', [
    { text: 'Enable and start', command: 'sudo systemctl enable --now <service>' },
    { text: 'Check', command: 'systemctl is-enabled <service>; systemctl is-active <service>' },
  ]),
  r('boot-errors', 'Find errors from the last boot / after a crash', 'Logs', 'crash reboot boot errors previous last kernel panic freeze froze logs why', [
    { text: 'Errors from the current boot', command: 'journalctl -b -p err --no-pager | tail -50' },
    { text: 'Errors from the previous boot (before the crash)', command: 'journalctl -b -1 -p warning --no-pager | tail -80' },
    { text: 'Kernel messages', command: 'sudo dmesg -T -l err,warn | tail -40' },
    { text: 'Boot history', command: 'journalctl --list-boots | tail' },
  ], 'If -b -1 is empty, enable a persistent journal: sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald'),
  r('cron-job', 'Schedule a recurring job', 'Scheduling', 'schedule cron job recurring every night daily hourly timer automate backup run periodically', [
    { text: 'Edit your crontab', command: 'crontab -e' },
    { text: 'Example line — every day at 03:00, logging output', command: '0 3 * * * /home/me/backup.sh >> /home/me/backup.log 2>&1' },
    { text: 'List jobs', command: 'crontab -l' },
    { text: 'Or check systemd timers', command: 'systemctl list-timers' },
  ], 'Format: minute hour day-of-month month day-of-week. crontab.guru explains any expression.'),

  // ---------------------------------------------------------------- performance
  r('high-cpu', 'Find what is using CPU or memory', 'Processes', 'cpu memory ram high usage slow load process hog top consuming eating', [
    { text: 'Top CPU consumers', command: 'ps aux --sort=-%cpu | head -12' },
    { text: 'Top memory consumers', command: 'ps aux --sort=-%mem | head -12' },
    { text: 'Per container', command: 'docker stats --no-stream' },
    { text: 'Load vs cores', command: 'uptime; nproc' },
  ]),
  r('out-of-memory', 'Did something get OOM-killed?', 'Processes', 'oom killed out of memory killer crashed container memory ram exhausted', [
    { text: 'Kernel OOM events', command: 'sudo dmesg -T | grep -i -E "out of memory|oom-kill|killed process"' },
    { text: 'From the journal', command: 'journalctl -k -b | grep -i oom' },
    { text: 'Containers killed for memory', command: "docker ps -a --filter 'exited=137'" },
  ]),
  r('disk-health', 'Check disk health (SMART)', 'Disks', 'disk health smart failing hdd ssd nvme errors reallocated bad sectors drive dying', [
    { text: 'List disks', command: 'lsblk -do NAME,SIZE,MODEL,SERIAL,ROTA' },
    { text: 'Quick verdict', command: 'sudo smartctl -H /dev/sda' },
    { text: 'Warning attributes', command: 'sudo smartctl -a /dev/sda | grep -Ei "realloc|pending|uncorrect|crc|wear|percentage used"' },
    { text: 'Start a long self-test (runs in background)', command: 'sudo smartctl -t long /dev/sda' },
  ]),
  r('temps', 'Check temperatures', 'Hardware', 'temperature temp hot heat overheating cpu gpu fan sensors thermal', [
    { text: 'All sensors', command: 'sensors' },
    { text: 'Raw thermal zones', command: 'paste <(cat /sys/class/thermal/thermal_zone*/type) <(cat /sys/class/thermal/thermal_zone*/temp)' },
    { text: 'NVIDIA GPU', command: 'nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu --format=csv' },
  ]),

  // ---------------------------------------------------------------- updates
  r('update-system', 'Update the system packages', 'Packages', 'update upgrade packages patch system os security updates apt dnf pacman', [
    { text: 'Debian / Ubuntu / Proxmox', command: 'sudo apt update && sudo apt full-upgrade -y' },
    { text: 'Fedora / RHEL / Rocky', command: 'sudo dnf upgrade --refresh -y' },
    { text: 'Arch', command: 'sudo pacman -Syu' },
    { text: 'Alpine', command: 'sudo apk update && sudo apk upgrade' },
    { text: 'Reboot needed?', command: '[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo "no reboot required"' },
  ]),
  r('auto-updates', 'Enable automatic security updates', 'Packages', 'automatic unattended updates security auto patch', [
    { text: 'Debian / Ubuntu', command: 'sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades' },
    { text: 'Fedora / RHEL', command: 'sudo dnf install -y dnf-automatic && sudo systemctl enable --now dnf-automatic-install.timer' },
  ]),
  r('update-compose', 'Update Docker Compose containers', 'Containers', 'update docker compose containers images pull upgrade stack newer version latest', [
    { text: 'In the folder with docker-compose.yml', command: 'docker compose pull && docker compose up -d' },
    { text: 'Clean up old images afterwards', command: 'docker image prune -f' },
    { text: 'Check what is running', command: 'docker compose ps' },
  ], 'Pin important images to a version tag rather than :latest so updates are deliberate.'),

  // ---------------------------------------------------------------- containers
  r('container-logs', 'See why a container keeps restarting', 'Containers', 'container restarting crash loop logs docker exited unhealthy why failing', [
    { text: 'State, exit code and restart count', command: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}'" },
    { text: 'Last logs', command: 'docker logs --tail 100 <container>' },
    { text: 'Exit code and OOM flag', command: "docker inspect <container> --format '{{.State.ExitCode}} oom={{.State.OOMKilled}} {{.State.Error}}'" },
    { text: 'Healthcheck output', command: "docker inspect <container> --format '{{json .State.Health}}' | jq" },
  ]),
  r('container-shell', 'Get a shell inside a container', 'Containers', 'shell inside container exec bash sh enter attach console', [
    { text: 'Docker', command: 'docker exec -it <container> sh' },
    { text: 'Compose service', command: 'docker compose exec <service> sh' },
    { text: 'Proxmox LXC', command: 'pct enter <ctid>' },
    { text: 'Kubernetes pod', command: 'kubectl exec -it <pod> -- sh' },
  ]),
  r('docker-no-sudo', 'Run docker without sudo', 'Containers', 'docker permission denied sock without sudo group user', [
    { text: 'Add yourself to the docker group', command: 'sudo usermod -aG docker $USER' },
    { text: 'Log out and back in (or start a new shell)', command: 'newgrp docker' },
  ], 'Membership of the docker group is effectively root access on that host.'),

  // ---------------------------------------------------------------- users & ssh
  r('ssh-key-login', 'Set up SSH key login (and turn off passwords)', 'SSH', 'ssh key login passwordless authorized_keys disable password authentication harden', [
    { text: 'In WebSSH: Keys → Generate, then "Install on host" for each server. Or from a shell:', command: 'ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host' },
    { text: 'Verify key login works in a NEW session, then disable passwords', command: "sudo sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config" },
    { text: 'Validate and reload', command: 'sudo sshd -t && sudo systemctl reload ssh || sudo systemctl reload sshd' },
  ], 'Keep your current session open until you have confirmed a new one can log in.'),
  r('host-key-changed', 'Fix "REMOTE HOST IDENTIFICATION HAS CHANGED"', 'SSH', 'host key changed identification warning known_hosts mismatch reinstall', [
    { text: 'If you reinstalled the host, remove the old key', command: 'ssh-keygen -R <host-or-ip>' },
    { text: 'Compare with the real fingerprint on the server console', command: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' },
  ], 'In WebSSH: Hosts → edit → "Reset host key" (only after verifying the new fingerprint).'),
  r('add-user', 'Create a new admin user', 'Users', 'add create new user account admin sudo', [
    { text: 'Debian / Ubuntu', command: 'sudo adduser alice && sudo usermod -aG sudo alice' },
    { text: 'Fedora / RHEL', command: 'sudo useradd -m -G wheel alice && sudo passwd alice' },
  ]),
  r('passwordless-sudo', 'Allow a command with sudo without a password', 'Users', 'sudo nopasswd passwordless without password sudoers', [
    { text: 'Create a drop-in (syntax-checked editor)', command: 'sudo visudo -f /etc/sudoers.d/webssh' },
    { text: 'Example line limiting it to service management', command: 'alice ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/docker, /usr/bin/journalctl' },
  ], 'Needed for WebSSH service/docker buttons and sudo file editing when you do not log in as root.'),
  r('who-logged-in', 'Who logged in / failed login attempts', 'Security', 'who logged in login attempts failed brute force ssh auth log intrusion', [
    { text: 'Current sessions', command: 'w' },
    { text: 'Recent logins', command: 'last -ai | head -20' },
    { text: 'Failed SSH logins', command: "journalctl -u ssh -u sshd --since today | grep -Ei 'failed|invalid' | tail -30" },
    { text: 'fail2ban bans', command: 'sudo fail2ban-client status sshd' },
  ]),

  // ---------------------------------------------------------------- files & backup
  r('backup-folder', 'Back up a folder to another machine', 'Backup', 'backup copy sync folder directory another machine nas remote rsync mirror', [
    { text: 'Preview what would be copied', command: 'rsync -avhn ~/docker/ nas:/tank/backups/docker/' },
    { text: 'Run it (incremental, resumable)', command: 'rsync -avhP ~/docker/ nas:/tank/backups/docker/' },
    { text: 'Compressed archive with a date', command: 'tar -czf ~/backup-$(date +%F).tar.gz ~/docker' },
  ], 'For real backups with history and encryption, look at restic or borg (both free).'),
  r('zfs-snapshot', 'Snapshot and roll back with ZFS', 'ZFS & RAID', 'zfs snapshot rollback restore before upgrade undo', [
    { text: 'Snapshot (recursive)', command: 'sudo zfs snapshot -r tank/docker@before-upgrade' },
    { text: 'List snapshots', command: 'zfs list -t snapshot -o name,used,creation' },
    { text: 'Roll back (discards changes since the snapshot)', command: 'sudo zfs rollback tank/docker@before-upgrade' },
  ]),
  r('pool-health', 'Check ZFS / RAID health', 'ZFS & RAID', 'zfs pool raid health degraded status scrub mdadm array', [
    { text: 'ZFS pools', command: 'zpool status -x' },
    { text: 'mdadm arrays', command: 'cat /proc/mdstat' },
    { text: 'Start a ZFS scrub', command: 'sudo zpool scrub <pool>' },
  ]),
  r('mount-share', 'Mount an NFS or SMB share', 'Disks', 'mount nfs smb cifs share network nas samba fstab', [
    { text: 'NFS', command: 'sudo mount -t nfs nas:/export/media /mnt/media' },
    { text: 'SMB / CIFS', command: 'sudo mount -t cifs //nas/share /mnt/share -o username=me,uid=$(id -u),gid=$(id -g)' },
    { text: 'Permanent: add to /etc/fstab, then test', command: 'sudo mount -a && findmnt /mnt/media' },
  ]),
  r('permissions-fix', 'Fix "permission denied" on a container volume', 'Containers', 'permission denied volume bind mount container uid gid puid pgid ownership', [
    { text: 'Who owns the folder?', command: 'ls -ln <folder>' },
    { text: 'Which uid does the container run as?', command: 'docker exec <container> id' },
    { text: 'Give the folder to that uid (example 1000)', command: 'sudo chown -R 1000:1000 <folder>' },
  ], 'Many images (linuxserver.io) take PUID/PGID environment variables — match them to `id` of your user.'),
  r('find-text', 'Find which file contains some text', 'Search', 'find text string inside files grep search contains config where defined', [
    { text: 'Recursive search with line numbers', command: 'grep -rn "search text" /etc 2>/dev/null' },
    { text: 'Only file names', command: 'grep -rl "search text" .' },
  ]),
  r('find-file', 'Find a file by name', 'Search', 'find file name where is located search filename', [
    { text: 'Search by name', command: 'find / -xdev -iname "*name*" 2>/dev/null' },
    { text: 'Fast index-based search', command: 'locate -i name' },
  ]),

  // ---------------------------------------------------------------- proxmox & vms
  r('proxmox-list', 'List Proxmox VMs and containers', 'Virtualization', 'proxmox pve vm vms lxc containers list status qm pct', [
    { text: 'VMs', command: 'qm list' },
    { text: 'LXC containers', command: 'pct list' },
    { text: 'Whole cluster', command: 'pvesh get /cluster/resources --type vm --output-format text' },
  ]),
  r('reboot-safely', 'Reboot safely', 'Power', 'reboot restart safely shutdown power cycle schedule', [
    { text: 'Check nothing important is running', command: 'docker ps; who' },
    { text: 'Reboot in 1 minute (cancel with sudo shutdown -c)', command: 'sudo shutdown -r +1 "Rebooting for maintenance"' },
  ], 'Make sure this host is reachable again after boot (WebSSH, Cloudflare Tunnel and VPN services enabled at boot).'),
  r('tls-expiry', 'Check when a TLS certificate expires', 'Security', 'certificate ssl tls expiry expire expiration https cert date', [
    { text: 'From a live site', command: 'echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -dates -issuer' },
    { text: 'From a file', command: 'openssl x509 -in cert.pem -noout -dates -subject' },
  ]),
  r('generate-secret', 'Generate a random password or secret', 'Security', 'generate random password secret token key string', [
    { text: '32 random bytes, base64', command: 'openssl rand -base64 32' },
    { text: 'Hex', command: 'openssl rand -hex 32' },
  ]),
  r('tmux-persistent', 'Keep a long job running after you disconnect', 'Shell', 'keep running disconnect background long job persistent session tmux screen nohup survive close', [
    { text: 'Start or attach to a tmux session', command: 'tmux new -As work' },
    { text: 'Detach: press Ctrl-b then d. Reattach later with', command: 'tmux attach -t work' },
  ], 'WebSSH also keeps your shell alive for a while after the browser disconnects, and lets you re-attach from another device.'),
  r('timezone-ntp', 'Fix the clock / timezone', 'System', 'time clock wrong timezone ntp sync date totp codes invalid', [
    { text: 'Status', command: 'timedatectl' },
    { text: 'Set timezone', command: 'sudo timedatectl set-timezone Europe/Lisbon' },
    { text: 'Enable NTP sync', command: 'sudo timedatectl set-ntp true' },
  ], 'A wrong clock breaks TLS and two-factor codes.'),
];

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES.find((x) => x.id === id);
}
