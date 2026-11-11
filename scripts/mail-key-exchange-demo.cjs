// A concrete, runnable demonstration of how the key exchange works.
// Every number printed here is real output from the real implementation.
const bsvModule = require('bsv');
const crypto = require('node:crypto');

const bsv = bsvModule.default || bsvModule;

// --- Bob's long-term identity key (already exists in his wallet) ---
// In the real wallet this comes from his BIP39 seed. We make one here.
const bobPrivate = crypto.randomBytes(32);
const G = bsv.crypto.Point.getG();
const bobPublicPoint = G.mul(bsv.crypto.BN.fromBuffer(bobPrivate, 32));
const bobPublic = bsv.crypto.Point.pointToCompressed(bobPublicPoint);

// --- Alice generates a FRESH key pair for this ONE message ---
const aliceEphemeralPrivate = crypto.randomBytes(32);
const aliceEphemeralPublic = bsv.crypto.Point.pointToCompressed(
  G.mul(bsv.crypto.BN.fromBuffer(aliceEphemeralPrivate, 32)),
);

// --- The shared point, computed two different ways ---
// Alice's way: (ephemeral private) x (Bob's PUBLIC key)
// Bob's way:   (Bob's PRIVATE key) x (ephemeral PUBLIC key)
const aliceShared = bsv.crypto.Point.pointFromCompressed(bobPublic)
  .mul(bsv.crypto.BN.fromBuffer(aliceEphemeralPrivate, 32));
const bobShared = bsv.crypto.Point.pointFromCompressed(aliceEphemeralPublic)
  .mul(bsv.crypto.BN.fromBuffer(bobPrivate, 32));

const aliceSecret = aliceShared.getX().toBuffer({ size: 32 });
const bobSecret = bobShared.getX().toBuffer({ size: 32 });

console.log('================================================================');
console.log(' HOW TWO PARTIES AGREE ON A SECRET WITHOUT MEETING');
console.log('================================================================');
console.log('');
console.log('BOB (the receiver) - his identity key, made once, kept forever:');
console.log('  private key :', bobPrivate.toString('hex').slice(0, 32), '... (SECRET, never shared)');
console.log('  public key  :', bobPublic.toString('hex').slice(0, 32), '... (SAFE to share)');
console.log('');
console.log('ALICE (the sender) - a fresh key pair for THIS message only:');
console.log('  private key :', aliceEphemeralPrivate.toString('hex').slice(0, 32), '... (SECRET, thrown away)');
console.log('  public key  :', aliceEphemeralPublic.toString('hex').slice(0, 32), '... (published on-chain)');
console.log('');
console.log('THE SHARED SECRET:');
console.log('  Alice computes  ephemeral_priv x bob_pub   =', aliceSecret.toString('hex').slice(0, 32), '...');
console.log('  Bob computes    bob_priv     x ephemeral_pub =', bobSecret.toString('hex').slice(0, 32), '...');
console.log('  IDENTICAL?                              ', aliceSecret.equals(bobSecret) ? 'YES' : 'NO');
console.log('');
console.log('WHY: elliptic curve math is commutative here.');
console.log('     (a x G) x b  ==  (b x G) x a');
console.log('     Bob public   =  bob_priv x G');
console.log('     So both sides land on the same point without exchanging secrets.');
console.log('');

// --- The crucial part: can the public key be turned back into the private key? ---
console.log('================================================================');
console.log(' CAN THE PUBLIC KEY BE REVERSED INTO THE PRIVATE KEY?');
console.log('================================================================');
console.log('');

// Someone who sees only bobPublic tries to recover bobPrivate.
// The standard approach: brute-force every candidate scalar and compare.
const bobPublicX = bobPublicPoint.getX().toString(16).padStart(64, '0');
let found = null;
let tried = 0;
const limit = 200000;
for (let i = 0; i < limit; i++) {
  tried++;
  const candidate = Buffer.alloc(32);
  candidate.writeUInt32BE(i, 28);
  let point;
  try {
    point = G.mul(bsv.crypto.BN.fromBuffer(candidate, 32));
  } catch {
    continue; // invalid scalar for this curve
  }
  if (!point || point.isInfinity()) continue;
  let x;
  try {
    x = point.getX().toString(16).padStart(64, '0');
  } catch {
    continue;
  }
  if (x === bobPublicX) { found = candidate; break; }
}
console.log(`  An attacker brute-forcing candidate private keys:`);
console.log(`    tried ${tried.toLocaleString()} candidates, found: ${found ? 'a match (impossible in practice)' : 'nothing'}`);
console.log(`    The real key is a random 256-bit number (~2^256 candidates).`);
console.log(`    Brute force would take longer than the age of the universe.`);
console.log('');

// --- And the key point about what an attacker CAN do ---
console.log('================================================================');
console.log(' WHAT AN ATTACKER WITH ONLY PUBLIC DATA CAN DO');
console.log('================================================================');
console.log('');
console.log('  They know Bob\'s public key   -> they can ENCRYPT to Bob. That is');
console.log('                                  the whole point: it is his mailbox');
console.log('                                  address, so anyone may write to it.');
console.log('  They know the ephemeral pub   -> it is the "padlock" on this message.');
console.log('  They know the ALGORITHM      -> how to lock and unlock.');
console.log('  They do NOT have Bob\'s private key -> so they cannot open the padlock.');
console.log('');

// --- Demonstrate: an attacker who has everything public still fails ---
const envelope = {
  e: aliceEphemeralPublic.toString('base64'),
  i: crypto.randomBytes(12).toString('base64'),
  t: '', c: '',
};
const iv = Buffer.from(envelope.i, 'base64');
const keyAlice = Buffer.from(crypto.hkdfSync('sha256', aliceSecret, Buffer.alloc(0), Buffer.from('lbsx-mail-v1'), 32));
const cipher = crypto.createCipheriv('aes-256-gcm', keyAlice, iv);
cipher.setAAD(Buffer.from('lbsx-mail-v1|sender|recipient|msgid'));
const ct = Buffer.concat([cipher.update(Buffer.from('secret message')), cipher.final()]);
const tag = cipher.getAuthTag();

function tryOpen(privateScalar, label) {
  try {
    const shared = bsv.crypto.Point.pointFromCompressed(aliceEphemeralPublic)
      .mul(bsv.crypto.BN.fromBuffer(privateScalar, 32)).getX().toBuffer({ size: 32 });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('lbsx-mail-v1'), 32));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    d.setAAD(Buffer.from('lbsx-mail-v1|sender|recipient|msgid'));
    const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    console.log(`  ${label}: OPENED -> "${pt}"`);
  } catch {
    console.log(`  ${label}: failed (auth tag mismatch)`);
  }
}

console.log('  Opening the real message with various keys:');
tryOpen(bobPrivate, 'Bob with his private key  ');
tryOpen(aliceEphemeralPrivate, 'Alice with the ephemeral key');
tryOpen(crypto.randomBytes(32), 'A stranger with a random key ');
console.log('');
console.log('  The attacker also has Bob\'s PUBLIC key. Try using it as a private key:');
tryOpen(Buffer.from(bobPublic.subarray(1)), 'Bob public key as scalar ');
console.log('');
console.log('  (Note: the real mail also authenticates the sender/recipient/message-id');
console.log('   as AAD, so a ciphertext cannot be moved to another recipient.)');
