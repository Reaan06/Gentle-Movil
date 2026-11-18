# Fish completions for `gentle-movil` (Gentle Movil host-side CLI).
#
# Install (no npm involved):
#   ln -sf <repo>/cli/gentle-movil.mjs ~/.local/bin/gentle-movil
#   chmod +x <repo>/cli/gentle-movil.mjs
#   cp <repo>/cli/completions/gentle-movil.fish ~/.config/fish/completions/
#
# The CLI is a node script with a shebang, so these completions work the same
# whether `gentle-movil` resolves through ~/.local/bin or a repo-local path.

complete -c gentle-movil -f

complete -c gentle-movil -n '__fish_use_subcommand' -a pair -d 'Show a one-time pairing QR in the terminal (gc://pair)'
complete -c gentle-movil -n '__fish_use_subcommand' -a status -d 'Is the Gentle Shell/Pi extension answering on loopback?'
complete -c gentle-movil -n '__fish_use_subcommand' -a doctor -d 'Preflight: sshd, host key, LAN IP, extension on loopback'
complete -c gentle-movil -n '__fish_use_subcommand' -a help -d 'Show the command help'

# pair
complete -c gentle-movil -n '__fish_seen_subcommand_from pair' -l invite-only -d 'QR with a pairing code instead of the SSH password (no prompt, no TTY needed)'
complete -c gentle-movil -n '__fish_seen_subcommand_from pair' -s h -l help -d 'Show the command help'

# status
complete -c gentle-movil -n '__fish_seen_subcommand_from status' -s h -l help -d 'Show the command help'

# doctor
complete -c gentle-movil -n '__fish_seen_subcommand_from doctor' -s h -l help -d 'Show the command help'

# Global help flags, valid with or without a subcommand.
complete -c gentle-movil -s h -l help -d 'Show the command help'
