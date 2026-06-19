package decoder

import "testing"

func TestChannelKeyMatchesMeshCoreHash(t *testing.T) {
	const publicKey = "8b3387e9c5cdea6ac9e5edbaa115cd72"
	if !channelKeyMatchesHash(publicKey, 0x11) {
		t.Fatal("expected Public key to match its MeshCore channel hash")
	}
	if channelKeyMatchesHash(publicKey, 0x12) {
		t.Fatal("key must not match a different channel hash")
	}
	if channelKeyMatchesHash("invalid", 0x11) {
		t.Fatal("invalid keys must not match")
	}
}

func TestDecodeEncryptedPayloadUsesPathHashSize(t *testing.T) {
	pkt, err := DecodePacket("0941aabb1122334455667788", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Path.HashSize != 2 {
		t.Fatalf("expected path hash size 2, got %d", pkt.Path.HashSize)
	}
	if pkt.Payload.DestHash != "1122" {
		t.Fatalf("expected 2-byte dest hash 1122, got %q", pkt.Payload.DestHash)
	}
	if pkt.Payload.SrcHash != "3344" {
		t.Fatalf("expected 2-byte src hash 3344, got %q", pkt.Payload.SrcHash)
	}
	if pkt.Payload.MAC != "5566" || pkt.Payload.EncryptedData != "7788" {
		t.Fatalf("unexpected payload split: mac=%q enc=%q", pkt.Payload.MAC, pkt.Payload.EncryptedData)
	}
}

func TestDecodePathPayloadUsesThreeByteHashes(t *testing.T) {
	pkt, err := DecodePacket("2181abcdef010203040506aabbccdd", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Path.HashSize != 3 {
		t.Fatalf("expected path hash size 3, got %d", pkt.Path.HashSize)
	}
	if pkt.Payload.DestHash != "010203" {
		t.Fatalf("expected 3-byte dest hash, got %q", pkt.Payload.DestHash)
	}
	if pkt.Payload.SrcHash != "040506" {
		t.Fatalf("expected 3-byte src hash, got %q", pkt.Payload.SrcHash)
	}
	if pkt.Payload.MAC != "aabb" || pkt.Payload.PathData != "ccdd" {
		t.Fatalf("unexpected PATH payload split: mac=%q path=%q", pkt.Payload.MAC, pkt.Payload.PathData)
	}
}

func TestDecodeAnonReqUsesPathHashSize(t *testing.T) {
	ephemeral := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	raw := "1d410102aabb" + ephemeral + "ccdd" + "eeff"
	pkt, err := DecodePacket(raw, nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Payload.DestHash != "aabb" {
		t.Fatalf("expected 2-byte dest hash aabb, got %q", pkt.Payload.DestHash)
	}
	if pkt.Payload.EphemeralPubKey != ephemeral {
		t.Fatalf("ephemeral key offset drifted: %q", pkt.Payload.EphemeralPubKey)
	}
	if pkt.Payload.MAC != "ccdd" || pkt.Payload.EncryptedData != "eeff" {
		t.Fatalf("unexpected ANON_REQ split: mac=%q enc=%q", pkt.Payload.MAC, pkt.Payload.EncryptedData)
	}
}

func TestDecodeTraceUsesPayloadHashSizeAndSNR(t *testing.T) {
	pkt, err := DecodePacket("2602fc04efbeadde7856341201aabbccdd", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Path.HashSize != 2 {
		t.Fatalf("expected TRACE payload hash size 2, got %d", pkt.Path.HashSize)
	}
	if pkt.Path.HashCount != 2 || len(pkt.Path.Hops) != 2 {
		t.Fatalf("expected 2 TRACE hops, got count=%d hops=%v", pkt.Path.HashCount, pkt.Path.Hops)
	}
	if pkt.Path.Hops[0] != "AABB" || pkt.Path.Hops[1] != "CCDD" {
		t.Fatalf("unexpected TRACE hops: %v", pkt.Path.Hops)
	}
	if pkt.Path.HopsCompleted == nil || *pkt.Path.HopsCompleted != 2 {
		t.Fatalf("expected 2 completed hops, got %v", pkt.Path.HopsCompleted)
	}
	if len(pkt.Payload.SNRValues) != 2 || pkt.Payload.SNRValues[0] != -1 || pkt.Payload.SNRValues[1] != 1 {
		t.Fatalf("unexpected TRACE SNR values: %v", pkt.Payload.SNRValues)
	}
}

func TestDecodeEncryptedPayloadTooShortForMultiByteHashes(t *testing.T) {
	pkt, err := DecodePacket("0941aabb1122334455", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Payload.Error != "too short" {
		t.Fatalf("expected payload too short error, got %q", pkt.Payload.Error)
	}
	if pkt.Payload.RawHex != "1122334455" {
		t.Fatalf("expected raw payload to be preserved, got %q", pkt.Payload.RawHex)
	}
}

func TestDecodeZeroHopDirectPayloadFallsBackToOneByteHashes(t *testing.T) {
	pkt, err := DecodePacket("0a001122334455", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Path.HashSize != 0 {
		t.Fatalf("expected zero-hop direct path hash size 0, got %d", pkt.Path.HashSize)
	}
	if pkt.Payload.DestHash != "11" || pkt.Payload.SrcHash != "22" {
		t.Fatalf("expected legacy 1-byte hashes, got dest=%q src=%q", pkt.Payload.DestHash, pkt.Payload.SrcHash)
	}
	if pkt.Payload.MAC != "3344" || pkt.Payload.EncryptedData != "55" {
		t.Fatalf("unexpected payload split: mac=%q enc=%q", pkt.Payload.MAC, pkt.Payload.EncryptedData)
	}
}

func TestDecodeTraceNonDirectAnomaly(t *testing.T) {
	pkt, err := DecodePacket("2502fc04efbeadde7856341201aabbccdd", nil)
	if err != nil {
		t.Fatalf("DecodePacket: %v", err)
	}
	if pkt.Anomaly != "TRACE packet with non-DIRECT routing (expected DIRECT or TRANSPORT_DIRECT)" {
		t.Fatalf("expected non-direct TRACE anomaly, got %q", pkt.Anomaly)
	}
}
