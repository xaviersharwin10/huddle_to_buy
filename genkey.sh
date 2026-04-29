cd axl
for n in nodeA nodeB nodeC nodeS; do
  openssl genpkey -algorithm ed25519 -out data/$n/private.pem
done
