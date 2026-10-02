/**
 * Heuristic shell command risk classifier.
 *
 *  - read:      inspects state only (eligible for optional auto-approval of AI commands)
 *  - write:     changes state — always needs explicit approval
 *  - dangerous: destructive / hard to undo — needs a second, explicit confirmation
 *
 * This is a guard rail for humans approving AI suggestions, not a sandbox: it
 * errs on the side of "write" whenever it cannot prove a command is read-only.
 */
export type Risk = 'read' | 'write' | 'dangerous';

export interface Classification {
  risk: Risk;
  reasons: string[];
}

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+.*--no-preserve-root/, 'rm --no-preserve-root'],
  [/\bmkfs(\.\w+)?\b/, 'formats a filesystem'],
  [/\bwipefs\b/, 'wipes filesystem signatures'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'dd writing to a raw device'],
  [/>\s*\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|md|dm-)/, 'redirect onto a raw block device'],
  [/\b(shred|blkdiscard)\b/, 'irreversibly destroys data'],
  [/\b(fdisk|sfdisk|gdisk|sgdisk|parted|cfdisk)\b(?![^|;&]*\s-l\b)/, 'partition table editor'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\b(shutdown|poweroff|halt|reboot|kexec)\b/, 'shuts down or reboots the machine'],
  [/\binit\s+[06]\b/, 'shuts down or reboots the machine'],
  [/\bsystemctl\s+(--\S+\s+)*(reboot|poweroff|halt|kexec|rescue|emergency|isolate)\b/, 'changes system power state'],
  [/\b(zpool\s+(destroy|labelclear)|zfs\s+destroy)\b/, 'destroys ZFS data'],
  [/\b(lvremove|vgremove|pvremove|mdadm\s+--zero-superblock)\b/, 'removes storage volumes'],
  [/\bdocker\s+(system|volume|image|container|network)\s+prune\b.*(-a|--all|--volumes|-f)/, 'prunes Docker data'],
  [/\bdocker\s+volume\s+rm\b/, 'deletes Docker volumes'],
  [/\b(qm|pct)\s+destroy\b/, 'destroys a Proxmox VM/container'],
  [/\bvirsh\s+(undefine|destroy)\b/, 'removes or kills a VM'],
  [/\b(iptables|ip6tables)\s+(-F|--flush|-X|-P\s+\w+\s+DROP)/, 'flushes firewall rules (may cut your access)'],
  [/\bnft\s+flush\s+ruleset\b/, 'flushes firewall rules (may cut your access)'],
  [/\bufw\s+(reset|--force\s+reset)\b/, 'resets the firewall'],
  [/\b(userdel|deluser)\b/, 'deletes a user'],
  [/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/, 'recursive permission change on /'],
  [/\bchown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/, 'recursive ownership change on /'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'pipes a remote script straight into a shell'],
  [/\bcrontab\s+-r\b/, 'deletes the crontab'],
  [/\bkill(all)?\s+(-9\s+|-KILL\s+|-s\s+KILL\s+)?1(\s|$)/, 'kills PID 1'],
  [/>\s*\/etc\/(passwd|shadow|sudoers|fstab|ssh\/sshd_config)\b/, 'overwrites a critical config file'],
  [/\bmv\s+\/(bin|boot|etc|lib\w*|sbin|usr|var)\b/, 'moves a system directory'],
  [/\bsshd?_config\b.*\b(PasswordAuthentication|PermitRootLogin|AllowUsers)\b.*>/, 'changes SSH access settings'],
  [/\bpasswd\s+(-d|--delete)\b/, 'removes a password'],
  [/\bgit\s+push\s+.*(--force|-f)\b/, 'force-pushes git history'],
];

/** Read-only programs; value = allowed subcommands (undefined = any args OK unless flagged). */
const READ_ONLY: Record<string, RegExp | true> = {
  ls: true, ll: true, la: true, dir: true, tree: true, cat: true, tac: true, head: true, tail: true, less: true, more: true,
  grep: true, egrep: true, fgrep: true, rg: true, ag: true, wc: true, sort: true, uniq: true, cut: true, tr: true, column: true,
  awk: true, jq: true, yq: true, diff: true, cmp: true, file: true, stat: true, du: true, df: true, free: true, uptime: true,
  uname: true, hostname: true, hostnamectl: /^(status)?$/, whoami: true, id: true, groups: true, w: true, who: true, last: true,
  lastlog: true, date: true, cal: true, env: true, printenv: true, echo: true, printf: true, pwd: true, which: true, type: true,
  whereis: true, ps: true, pgrep: true, pstree: true, top: true, htop: true, btop: true, vmstat: true, iostat: true, mpstat: true,
  sar: true, nproc: true, lscpu: true, lsblk: true, blkid: true, lspci: true, lsusb: true, lsmod: true, lshw: true, dmidecode: true,
  sensors: true, findmnt: true, mount: /^$/, ip: /^(-\S+\s+)*(a|addr|address|r|route|l|link|n|neigh|neighbour|rule|-s|-4|-6|-br)(\s+(show|list|ls))?\b/,
  ifconfig: /^(\S+)?$/, ss: true, netstat: true, ping: true, ping6: true, traceroute: true, tracepath: true, mtr: true, dig: true,
  host: true, nslookup: true, resolvectl: /^(status|query|dns|statistics)\b/, arp: true, route: /^(-n)?$/, nmcli: /^(-\S+\s+)*(d|dev|device|c|con|connection|g|general|r|radio)(\s+(show|status|list))?\s*\S*$/,
  iwconfig: true, ethtool: true, journalctl: true, dmesg: /^(?!.*(-c|--clear|-C))/, systemctl: /^(--\S+\s+)*(status|show|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|is-active|is-enabled|is-failed|cat|get-default)\b/,
  timedatectl: /^(status|show|list-timezones)?$/, loginctl: /^(list-sessions|list-users|show-session|show-user|session-status|user-status)?\b/,
  docker: /^(ps|images|logs|inspect|stats|top|port|version|info|events|history|diff|volume\s+(ls|inspect)|network\s+(ls|inspect)|image\s+(ls|inspect|history)|container\s+(ls|inspect|logs|top|stats|port|diff)|compose\s+(ps|logs|config|ls|images|top|version))\b/,
  podman: /^(ps|images|logs|inspect|stats|top|port|version|info)\b/,
  kubectl: /^(get|describe|logs|top|version|cluster-info|api-resources|explain|config\s+(view|get-contexts|current-context))\b/,
  helm: /^(list|ls|status|history|get|version|show)\b/,
  git: /^(status|log|diff|show|branch|remote|tag|blame|rev-parse|describe|shortlog|ls-files|config\s+(--get|-l|--list))\b/,
  zpool: /^(status|list|iostat|get|history)\b/, zfs: /^(list|get)\b/, btrfs: /^(filesystem\s+(show|df|usage)|subvolume\s+(list|show)|device\s+stats|scrub\s+status)\b/,
  smartctl: /^(-[aHix]|--all|--health|--info|--xall|--scan)/, nvme: /^(list|smart-log)\b/, mdadm: /^(--detail|-D|--examine|-E|--query|-Q)\b/,
  lvs: true, vgs: true, pvs: true, lvdisplay: true, vgdisplay: true, pvdisplay: true,
  qm: /^(list|status|config|pending)\b/, pct: /^(list|status|config)\b/, pvesh: /^get\b/, pveversion: true, virsh: /^(list|dominfo|domstate|net-list|pool-list|vol-list|nodeinfo|version)\b/,
  apt: /^(list|show|search|policy)\b/, 'apt-cache': true, dpkg: /^(-l|-L|-s|-S|--list|--status|--search|--listfiles)\b/, rpm: /^-q/, dnf: /^(list|info|search|repolist|check-update|history\s+(list|info)?)\b/,
  yum: /^(list|info|search|repolist|check-update)\b/, pacman: /^-Q/, apk: /^(info|list|search|version)\b/, snap: /^(list|info|find|services)\b/, flatpak: /^(list|info|search)\b/,
  crontab: /^-l\b/, getent: true, realpath: true, readlink: true, basename: true, dirname: true, md5sum: true, sha1sum: true, sha256sum: true,
  base64: true, xxd: true, hexdump: true, od: true, strings: true, nl: true, fold: true, fmt: true, seq: true, test: true, '[': true, true: true,
  openssl: /^(x509|s_client|version|ciphers|crl|req\s+.*-noout)\b/, curl: /^(?!.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s|-F\s|--upload-file|-T\s|-o\s|-O\b|--output))/,
  wget: /^(?!.*(--post|-O\s*[^-]|--output-document=(?!-)))(.*\s)?(-q\s+)?(-O\s*-|--spider|-S)/, nc: /^-z/, nmap: true, tcpdump: /-c\s*\d+/, iperf3: /^-c\b/,
  'docker-compose': /^(ps|logs|config|images|top|version)\b/, tmux: /^(ls|list-sessions|list-windows|info)\b/, screen: /^-ls\b/,
  find: /^(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b)/, locate: true, man: true, help: true, tldr: true, sudo: true, watch: true,
  'nvidia-smi': /^(?!.*(-r|--gpu-reset|-pm|-pl|--persistence-mode|--power-limit))/, upsc: true, ipmitool: /^(sdr|sensor|sel\s+list|chassis\s+status|fru|lan\s+print|mc\s+info)\b/,
  timeout: true, xargs: true, sed: /^(?!.*(-i\b|--in-place))/, tee: /^\/dev\/null$/,
};

const WRAPPERS = new Set(['sudo', 'doas', 'time', 'nice', 'ionice', 'nohup', 'command', 'builtin', 'exec', 'stdbuf', 'timeout', 'watch', 'xargs', 'env']);

/** Split on shell control operators outside quotes. Returns segments and the operators between them. */
export function splitCommand(cmd: string): { segments: string[]; pipesInto: string[] } {
  const segments: string[] = [];
  const pipesInto: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|' || c === ';' || c === '\n' || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) {
      segments.push(cur);
      if (c === '|') pipesInto.push(String(segments.length));
      cur = '';
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), pipesInto };
}

function stripWrappers(seg: string): string {
  let s = seg.trim();
  // Leading env assignments: FOO=bar BAZ="x y" cmd
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  for (;;) {
    const m = /^(\S+)\s*/.exec(s);
    if (!m || !WRAPPERS.has(m[1])) break;
    const w = m[1];
    s = s.slice(m[0].length);
    // Drop wrapper options (sudo -n -u user, timeout 10, nice -n 5, watch -n 2 …)
    for (;;) {
      const o = /^(-{1,2}[A-Za-z][\w-]*)(=\S+)?\s*/.exec(s);
      if (!o) break;
      s = s.slice(o[0].length);
      if (/^-(u|g|n|p|c|s|k|d)$/.test(o[1]) && !o[2]) s = s.replace(/^\S+\s*/, '');
    }
    if ((w === 'timeout' || w === 'nice') && /^\d+[smhd]?\s/.test(s)) s = s.replace(/^\S+\s*/, '');
  }
  return s;
}

const CRITICAL_RM_TARGET =
  /^("|')?(\/|\/\*|~\/?|~\/\*|\$HOME\/?|\*|\.\.?\/?|\/(bin|boot|dev|etc|home|lib\w*|mnt|media|opt|proc|root|sbin|srv|sys|usr|var)(\/[^/\s]*)?\/?)("|')?$/;

/** Recursive rm aimed at /, ~, *, or a top-level system directory (or one level below it). */
function dangerousRm(segment: string): string | null {
  const inner = stripWrappers(segment);
  const parts = inner.split(/\s+/);
  if (parts[0]?.replace(/^.*\//, '') !== 'rm') return null;
  const args = parts.slice(1);
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  if (!recursive) return null;
  let endOfFlags = false;
  for (const a of args) {
    if (a === '--') {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.startsWith('-')) continue;
    if (CRITICAL_RM_TARGET.test(a)) return `recursive delete of ${a}`;
  }
  return null;
}

function hasWriteRedirect(seg: string): boolean {
  // Remove quoted strings, then look for > or >> not targeting /dev/null or fd duplication.
  const unquoted = seg.replace(/"(\\.|[^"])*"|'[^']*'/g, '""');
  const re = /(\d?|&)>>?\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(unquoted))) {
    const target = m[2];
    if (target === '/dev/null' || /^&\d$/.test(target) || target.startsWith('&')) continue;
    return true;
  }
  return false;
}

export function classifyCommand(command: string): Classification {
  const cmd = command.trim();
  const reasons: string[] = [];
  if (!cmd) return { risk: 'read', reasons: [] };

  for (const [re, why] of DANGEROUS) if (re.test(cmd)) reasons.push(why);
  for (const seg of splitCommand(cmd).segments) {
    const why = dangerousRm(seg);
    if (why) reasons.push(why);
  }
  if (reasons.length) return { risk: 'dangerous', reasons: [...new Set(reasons)] };

  // Command substitution (but not $(( arithmetic )) ) can hide anything.
  if (/`|\$\((?!\()/.test(cmd.replace(/'[^']*'/g, ''))) return { risk: 'write', reasons: ['uses command substitution'] };
  if (/<\(|>\(/.test(cmd)) return { risk: 'write', reasons: ['uses process substitution'] };

  const { segments } = splitCommand(cmd);
  for (const seg of segments) {
    if (hasWriteRedirect(seg)) return { risk: 'write', reasons: ['redirects output into a file'] };
    const inner = stripWrappers(seg);
    const m = /^(\S+)\s*(.*)$/s.exec(inner);
    if (!m) continue;
    const prog = m[1].replace(/^.*\//, '');
    const args = m[2].trim();
    if (/^(ba|z|da|k|fi)?sh$|^python\d?$|^perl$|^ruby$|^node$|^eval$|^source$|^\.$/.test(prog)) {
      return { risk: 'write', reasons: [`runs an interpreter (${prog})`] };
    }
    const rule = READ_ONLY[prog];
    if (!rule) return { risk: 'write', reasons: [`${prog} may change state`] };
    if (rule !== true && !rule.test(args)) return { risk: 'write', reasons: [`${prog} ${args.split(/\s+/)[0] ?? ''} may change state`.trim()] };
  }
  return { risk: 'read', reasons: [] };
}
