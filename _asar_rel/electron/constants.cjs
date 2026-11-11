// This address is PUBLIC BY DESIGN and is not a secret.
//
// It is the shared discovery anchor for the peer-to-peer trading and Peer Chat
// features. Transactions pay a small fee to it so that address-history
// indexers can find and parse the order announcements and chat payloads they
// carry.
//
// It is also the source of the Peer Chat obfuscation key
// (sha256(ADMIN_DISCOVERY_ADDRESS)). That key is therefore derivable by
// anyone: Peer Chat provides obfuscation against casual readers of the chain,
// NOT confidentiality against a motivated attacker. The application surfaces
// this trade-off to users in the Peer Chat info popover and the feature card.
//
// Rationale for keeping it in source rather than configuring it:
//   - it must be stable, since peers need to find each other's announcements
//   - it must be identical across every install for discovery to work
//   - it must NOT be treated as a key, because it confers no secret material
//
// Do not "fix" this by moving it to an environment variable or a config file.
// See SECURITY.md for the full reasoning and the associated trade-offs.
module.exports = {
  ADMIN_DISCOVERY_ADDRESS: '15BYCBgXi2GWXEvJNJJGfcYxeN9nQqp7eB',
};
