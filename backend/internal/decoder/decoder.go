// Package decoder implements MeshCore binary packet decoding.
// Ported from CoreScope cmd/ingestor/decoder.go.
package decoder

import (
	"crypto/aes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	RouteTransportFlood  = 0
	RouteFlood           = 1
	RouteDirect          = 2
	RouteTransportDirect = 3

	PayloadREQ      = 0x00
	PayloadRESPONSE = 0x01
	PayloadTXTMSG   = 0x02
	PayloadACK      = 0x03
	PayloadADVERT   = 0x04
	PayloadGRPTXT   = 0x05
	PayloadGRPDATA  = 0x06
	PayloadANONREQ  = 0x07
	PayloadPATH     = 0x08
	PayloadTRACE    = 0x09
	PayloadMULTI    = 0x0A
	PayloadCONTROL  = 0x0B
	PayloadRAWCUSTOM = 0x0F

	maxPathSize      = 64
	maxPacketPayload = 184
)

var routeNames = map[int]string{
	0: "TRANSPORT_FLOOD", 1: "FLOOD", 2: "DIRECT", 3: "TRANSPORT_DIRECT",
}

var payloadNames = map[int]string{
	0x00: "REQ", 0x01: "RESPONSE", 0x02: "TXT_MSG", 0x03: "ACK",
	0x04: "ADVERT", 0x05: "GRP_TXT", 0x06: "GRP_DATA", 0x07: "ANON_REQ",
	0x08: "PATH", 0x09: "TRACE", 0x0A: "MULTIPART", 0x0B: "CONTROL", 0x0F: "RAW_CUSTOM",
}

type Header struct {
	RouteType       int    `json:"routeType"`
	RouteTypeName   string `json:"routeTypeName"`
	PayloadType     int    `json:"payloadType"`
	PayloadTypeName string `json:"payloadTypeName"`
	PayloadVersion  int    `json:"payloadVersion"`
}

type TransportCodes struct {
	Code1 string `json:"code1"`
	Code2 string `json:"code2"`
}

type Path struct {
	HashSize      int      `json:"hashSize"`
	HashCount     int      `json:"hashCount"`
	Hops          []string `json:"hops"`
	HopsCompleted *int     `json:"hopsCompleted,omitempty"`
}

type AdvertFlags struct {
	Raw         int  `json:"raw"`
	Type        int  `json:"type"`
	Chat        bool `json:"chat"`
	Repeater    bool `json:"repeater"`
	Room        bool `json:"room"`
	Sensor      bool `json:"sensor"`
	HasLocation bool `json:"hasLocation"`
	HasFeat1    bool `json:"hasFeat1"`
	HasFeat2    bool `json:"hasFeat2"`
	HasName     bool `json:"hasName"`
}

type Payload struct {
	Type             string       `json:"type"`
	DestHash         string       `json:"destHash,omitempty"`
	SrcHash          string       `json:"srcHash,omitempty"`
	MAC              string       `json:"mac,omitempty"`
	EncryptedData    string       `json:"encryptedData,omitempty"`
	PubKey           string       `json:"pubKey,omitempty"`
	Timestamp        uint32       `json:"timestamp,omitempty"`
	TimestampISO     string       `json:"timestampISO,omitempty"`
	Flags            *AdvertFlags `json:"flags,omitempty"`
	Lat              *float64     `json:"lat,omitempty"`
	Lon              *float64     `json:"lon,omitempty"`
	Name             string       `json:"name,omitempty"`
	BatteryMv        *int         `json:"battery_mv,omitempty"`
	TemperatureC     *float64     `json:"temperature_c,omitempty"`
	ChannelHash      int          `json:"channelHash,omitempty"`
	ChannelHashHex   string       `json:"channelHashHex,omitempty"`
	DecryptionStatus string       `json:"decryptionStatus,omitempty"`
	Channel          string       `json:"channel,omitempty"`
	Text             string       `json:"text,omitempty"`
	Sender           string       `json:"sender,omitempty"`
	SenderTimestamp  uint32       `json:"sender_timestamp,omitempty"`
	PathData         string       `json:"pathData,omitempty"`
	SNRValues        []float64    `json:"snrValues,omitempty"`
	Tag              uint32       `json:"tag,omitempty"`
	AuthCode         uint32       `json:"authCode,omitempty"`
	TraceFlags       *int         `json:"traceFlags,omitempty"`
	RawHex           string       `json:"raw,omitempty"`
	Error            string       `json:"error,omitempty"`
	Remaining        *int         `json:"remaining,omitempty"`
	InnerType        *int         `json:"innerType,omitempty"`
	InnerTypeName    string       `json:"innerTypeName,omitempty"`
	InnerAckCrc      string       `json:"innerAckCrc,omitempty"`
	InnerPayload     string       `json:"innerPayload,omitempty"`
	CtrlFlags        string       `json:"ctrlFlags,omitempty"`
	CtrlZeroHop      *bool        `json:"ctrlZeroHop,omitempty"`
	CtrlLength       *int         `json:"ctrlLength,omitempty"`
	RawLength        *int         `json:"rawLength,omitempty"`
	FirstByteTag     string       `json:"firstByteTag,omitempty"`
	EphemeralPubKey  string       `json:"ephemeralPubKey,omitempty"`
	ExtraHash        string       `json:"extraHash,omitempty"`
	DataType         *int         `json:"dataType,omitempty"`
	DataLen          *int         `json:"dataLen,omitempty"`
	DecryptedBlob    string       `json:"decryptedBlob,omitempty"`
}

type DecodedPacket struct {
	Header         Header          `json:"header"`
	TransportCodes *TransportCodes `json:"transportCodes"`
	Path           Path            `json:"path"`
	Payload        Payload         `json:"payload"`
	Raw            string          `json:"raw"`
	Anomaly        string          `json:"anomaly,omitempty"`
	PayloadRaw     []byte          `json:"-"`
}

func isTransportRoute(rt int) bool {
	return rt == RouteTransportFlood || rt == RouteTransportDirect
}

func decodeHeader(b byte) Header {
	rt := int(b & 0x03)
	pt := int((b >> 2) & 0x0F)
	pv := int((b >> 6) & 0x03)
	rn := routeNames[rt]
	if rn == "" {
		rn = "UNKNOWN"
	}
	pn := payloadNames[pt]
	if pn == "" {
		pn = "UNKNOWN"
	}
	return Header{RouteType: rt, RouteTypeName: rn, PayloadType: pt, PayloadTypeName: pn, PayloadVersion: pv}
}

func isValidPathLen(pb byte) bool {
	hc := int(pb & 0x3F)
	hs := int(pb>>6) + 1
	if hs == 4 {
		return false
	}
	return hc*hs <= maxPathSize
}

func decodePath(pb byte, buf []byte, off int) (Path, int, error) {
	hs := int(pb>>6) + 1
	hc := int(pb & 0x3F)
	if !isValidPathLen(pb) {
		return Path{}, 0, fmt.Errorf("invalid path: 0x%02X", pb)
	}
	hops := make([]string, 0, hc)
	for i := 0; i < hc; i++ {
		s, e := off+i*hs, off+i*hs+hs
		if e > len(buf) {
			break
		}
		hops = append(hops, strings.ToUpper(hex.EncodeToString(buf[s:e])))
	}
	return Path{HashSize: hs, HashCount: hc, Hops: hops}, hs * hc, nil
}

func decodeAdvert(buf []byte) Payload {
	if len(buf) < 100 {
		return Payload{Type: "ADVERT", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	pubKey := hex.EncodeToString(buf[0:32])
	ts := binary.LittleEndian.Uint32(buf[32:36])
	p := Payload{
		Type:         "ADVERT",
		PubKey:       pubKey,
		Timestamp:    ts,
		TimestampISO: time.Unix(int64(ts), 0).UTC().Format(time.RFC3339),
	}
	appdata := buf[100:]
	if len(appdata) == 0 {
		return p
	}
	flags := appdata[0]
	advType := int(flags & 0x0F)
	hasFeat1 := flags&0x20 != 0
	hasFeat2 := flags&0x40 != 0
	p.Flags = &AdvertFlags{
		Raw:         int(flags),
		Type:        advType,
		Chat:        advType == 1,
		Repeater:    advType == 2,
		Room:        advType == 3,
		Sensor:      advType == 4,
		HasLocation: flags&0x10 != 0,
		HasFeat1:    hasFeat1,
		HasFeat2:    hasFeat2,
		HasName:     flags&0x80 != 0,
	}
	off := 1
	if p.Flags.HasLocation && len(appdata) >= off+8 {
		lat := float64(int32(binary.LittleEndian.Uint32(appdata[off:off+4]))) / 1e6
		lon := float64(int32(binary.LittleEndian.Uint32(appdata[off+4:off+8]))) / 1e6
		p.Lat = &lat
		p.Lon = &lon
		off += 8
	}
	if hasFeat1 && len(appdata) >= off+2 {
		v := int(binary.LittleEndian.Uint16(appdata[off : off+2]))
		p.Flags.HasFeat1 = true
		_ = v
		off += 2
	}
	if hasFeat2 && len(appdata) >= off+2 {
		off += 2
	}
	if p.Flags.HasName {
		end := len(appdata)
		for i := off; i < len(appdata); i++ {
			if appdata[i] == 0 {
				end = i
				break
			}
		}
		name := sanitizeName(string(appdata[off:end]))
		if len([]rune(name)) > 32 {
			name = string([]rune(name)[:32])
		}
		p.Name = name
		off = end
		for off < len(appdata) && appdata[off] == 0 {
			off++
		}
	}
	if p.Flags.Sensor && off+4 <= len(appdata) {
		batt := int(binary.LittleEndian.Uint16(appdata[off : off+2]))
		tempRaw := int16(binary.LittleEndian.Uint16(appdata[off+2 : off+4]))
		if batt > 0 && batt <= 10000 {
			p.BatteryMv = &batt
		}
		if tempRaw >= -5000 && tempRaw <= 10000 {
			tempC := float64(tempRaw) / 100.0
			p.TemperatureC = &tempC
		}
	}
	return p
}

type channelDecryptResult struct {
	Timestamp uint32
	Sender    string
	Message   string
}

func decryptChannelMessage(ciphertextHex, macHex, keyHex string) (*channelDecryptResult, error) {
	key, err := hex.DecodeString(keyHex)
	if err != nil || len(key) != 16 {
		return nil, fmt.Errorf("invalid key")
	}
	macBytes, err := hex.DecodeString(macHex)
	if err != nil || len(macBytes) != 2 {
		return nil, fmt.Errorf("invalid MAC")
	}
	ct, err := hex.DecodeString(ciphertextHex)
	if err != nil || len(ct) == 0 {
		return nil, fmt.Errorf("invalid ciphertext")
	}
	secret := make([]byte, 32)
	copy(secret, key)
	h := hmac.New(sha256.New, secret)
	h.Write(ct)
	calc := h.Sum(nil)
	if calc[0] != macBytes[0] || calc[1] != macBytes[1] {
		return nil, fmt.Errorf("MAC mismatch")
	}
	if len(ct)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("not aligned")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	for i := 0; i < len(ct); i += aes.BlockSize {
		block.Decrypt(plain[i:i+aes.BlockSize], ct[i:i+aes.BlockSize])
	}
	if len(plain) < 5 {
		return nil, fmt.Errorf("too short after decrypt")
	}
	ts := binary.LittleEndian.Uint32(plain[0:4])
	text := string(plain[5:])
	if idx := strings.IndexByte(text, 0); idx >= 0 {
		text = text[:idx]
	}
	if !utf8.ValidString(text) || countNonPrint(text) > 2 {
		return nil, fmt.Errorf("invalid plaintext")
	}
	res := &channelDecryptResult{Timestamp: ts}
	if idx := strings.Index(text, ": "); idx > 0 && idx < 50 {
		candidate := text[:idx]
		if !strings.ContainsAny(candidate, ":[]") {
			res.Sender = candidate
			res.Message = text[idx+2:]
			return res, nil
		}
	}
	res.Message = text
	return res, nil
}

func countNonPrint(s string) int {
	n := 0
	for _, r := range s {
		if r < 0x20 && r != '\n' && r != '\t' {
			n++
		}
	}
	return n
}

func decodeGrpTxt(buf []byte, keys map[string]string) Payload {
	if len(buf) < 3 {
		return Payload{Type: "GRP_TXT", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	chHash := int(buf[0])
	chHex := fmt.Sprintf("%02X", buf[0])
	mac := hex.EncodeToString(buf[1:3])
	enc := hex.EncodeToString(buf[3:])
	if len(keys) > 0 && len(enc) >= 10 {
		for name, key := range keys {
			res, err := decryptChannelMessage(enc, mac, key)
			if err != nil {
				continue
			}
			return Payload{
				Type: "CHAN", Channel: normalizeName(name),
				ChannelHash: chHash, ChannelHashHex: chHex,
				DecryptionStatus: "decrypted",
				Sender:           res.Sender,
				Text:             formatText(res.Sender, res.Message),
				SenderTimestamp:  res.Timestamp,
			}
		}
		return Payload{Type: "GRP_TXT", ChannelHash: chHash, ChannelHashHex: chHex, DecryptionStatus: "decryption_failed", MAC: mac, EncryptedData: enc}
	}
	return Payload{Type: "GRP_TXT", ChannelHash: chHash, ChannelHashHex: chHex, DecryptionStatus: "no_key", MAC: mac, EncryptedData: enc}
}

func formatText(sender, msg string) string {
	if sender != "" && msg != "" {
		return sender + ": " + msg
	}
	return msg
}

func normalizeName(name string) string {
	if strings.EqualFold(name, "public") {
		return "Public"
	}
	return name
}

func decodeEncryptedPayload(typeName string, buf []byte) Payload {
	if len(buf) < 4 {
		return Payload{Type: typeName, Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	return Payload{
		Type:          typeName,
		DestHash:      hex.EncodeToString(buf[0:1]),
		SrcHash:       hex.EncodeToString(buf[1:2]),
		MAC:           hex.EncodeToString(buf[2:4]),
		EncryptedData: hex.EncodeToString(buf[4:]),
	}
}

func decodeAck(buf []byte) Payload {
	if len(buf) < 4 {
		return Payload{Type: "ACK", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	return Payload{Type: "ACK", ExtraHash: fmt.Sprintf("%08x", binary.LittleEndian.Uint32(buf[0:4]))}
}

func decodeAnonReq(buf []byte) Payload {
	if len(buf) < 35 {
		return Payload{Type: "ANON_REQ", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	return Payload{Type: "ANON_REQ", DestHash: hex.EncodeToString(buf[0:1]), EphemeralPubKey: hex.EncodeToString(buf[1:33]), MAC: hex.EncodeToString(buf[33:35]), EncryptedData: hex.EncodeToString(buf[35:])}
}

func decodePathPayload(buf []byte) Payload {
	if len(buf) < 4 {
		return Payload{Type: "PATH", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	return Payload{Type: "PATH", DestHash: hex.EncodeToString(buf[0:1]), SrcHash: hex.EncodeToString(buf[1:2]), MAC: hex.EncodeToString(buf[2:4]), PathData: hex.EncodeToString(buf[4:])}
}

func decodeTrace(buf []byte) Payload {
	if len(buf) < 9 {
		return Payload{Type: "TRACE", Error: "too short", RawHex: hex.EncodeToString(buf)}
	}
	flags := int(buf[8])
	p := Payload{Type: "TRACE", Tag: binary.LittleEndian.Uint32(buf[0:4]), AuthCode: binary.LittleEndian.Uint32(buf[4:8]), TraceFlags: &flags}
	if len(buf) > 9 {
		p.PathData = hex.EncodeToString(buf[9:])
	}
	return p
}

func decodeMultipart(buf []byte) Payload {
	if len(buf) < 1 {
		return Payload{Type: "MULTIPART", Error: "too short"}
	}
	rem := int(buf[0] >> 4)
	inner := int(buf[0] & 0x0F)
	name := payloadNames[inner]
	if name == "" {
		name = "UNKNOWN"
	}
	p := Payload{Type: "MULTIPART", Remaining: &rem, InnerType: &inner, InnerTypeName: name}
	if inner == PayloadACK && len(buf) >= 5 {
		p.InnerAckCrc = fmt.Sprintf("%08x", binary.LittleEndian.Uint32(buf[1:5]))
	} else if len(buf) > 1 {
		p.InnerPayload = hex.EncodeToString(buf[1:])
	}
	return p
}

func decodeControl(buf []byte) Payload {
	if len(buf) < 1 {
		return Payload{Type: "CONTROL", Error: "too short"}
	}
	zeroHop := buf[0]&0x80 != 0
	l := len(buf)
	return Payload{Type: "CONTROL", CtrlFlags: fmt.Sprintf("%02x", buf[0]), CtrlZeroHop: &zeroHop, CtrlLength: &l, RawHex: hex.EncodeToString(buf)}
}

func decodePayload(pt int, buf []byte, keys map[string]string) Payload {
	switch pt {
	case PayloadREQ:
		return decodeEncryptedPayload("REQ", buf)
	case PayloadRESPONSE:
		return decodeEncryptedPayload("RESPONSE", buf)
	case PayloadTXTMSG:
		return decodeEncryptedPayload("TXT_MSG", buf)
	case PayloadACK:
		return decodeAck(buf)
	case PayloadADVERT:
		return decodeAdvert(buf)
	case PayloadGRPTXT:
		return decodeGrpTxt(buf, keys)
	case PayloadANONREQ:
		return decodeAnonReq(buf)
	case PayloadPATH:
		return decodePathPayload(buf)
	case PayloadTRACE:
		return decodeTrace(buf)
	case PayloadMULTI:
		return decodeMultipart(buf)
	case PayloadCONTROL:
		return decodeControl(buf)
	case PayloadRAWCUSTOM:
		l := len(buf)
		p := Payload{Type: "RAW_CUSTOM", RawLength: &l, RawHex: hex.EncodeToString(buf)}
		if l > 0 {
			p.FirstByteTag = fmt.Sprintf("%02X", buf[0])
		}
		return p
	default:
		return Payload{Type: "UNKNOWN", RawHex: hex.EncodeToString(buf)}
	}
}

// DecodePacket decodes a hex-encoded MeshCore packet.
func DecodePacket(hexStr string, channelKeys map[string]string) (*DecodedPacket, error) {
	hexStr = strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(hexStr, " ", ""), "\n", ""), "\r", "")
	buf, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, fmt.Errorf("invalid hex: %w", err)
	}
	if len(buf) < 2 {
		return nil, fmt.Errorf("too short")
	}
	hdr := decodeHeader(buf[0])
	off := 1
	var tc *TransportCodes
	if isTransportRoute(hdr.RouteType) {
		if len(buf) < off+4 {
			return nil, fmt.Errorf("too short for transport codes")
		}
		tc = &TransportCodes{
			Code1: strings.ToUpper(hex.EncodeToString(buf[off : off+2])),
			Code2: strings.ToUpper(hex.EncodeToString(buf[off+2 : off+4])),
		}
		off += 4
	}
	if off >= len(buf) {
		return nil, fmt.Errorf("no path byte")
	}
	pb := buf[off]
	off++
	path, consumed, err := decodePath(pb, buf, off)
	if err != nil {
		return nil, err
	}
	off += consumed
	if off > len(buf) {
		return nil, fmt.Errorf("path overflows buffer")
	}
	payloadBuf := buf[off:]
	if len(payloadBuf) > maxPacketPayload {
		return nil, fmt.Errorf("payload too large")
	}
	payload := decodePayload(hdr.PayloadType, payloadBuf, channelKeys)
	if (hdr.RouteType == RouteDirect || hdr.RouteType == RouteTransportDirect) && pb&0x3F == 0 && hdr.PayloadType != PayloadTRACE {
		path.HashSize = 0
	}
	return &DecodedPacket{
		Header: hdr, TransportCodes: tc, Path: path, Payload: payload,
		Raw: strings.ToUpper(hexStr), PayloadRaw: payloadBuf,
	}, nil
}

// ResolveFloodScope matches a TC_FLOOD packet's transport code against a scope
// allowlist using the same HMAC derivation as the firmware's TransportKey::calcTransportCode.
// Returns the first matching scope name (e.g. "#waw") or "".
func (p *DecodedPacket) ResolveFloodScope(allowlist []string) string {
	if p.Header.RouteType != RouteTransportFlood || p.TransportCodes == nil {
		return ""
	}
	codeBytes, err := hex.DecodeString(p.TransportCodes.Code1)
	if err != nil || len(codeBytes) < 2 {
		return ""
	}
	pktCode := binary.LittleEndian.Uint16(codeBytes)

	msg := append([]byte{byte(p.Header.PayloadType)}, p.PayloadRaw...)
	for _, name := range allowlist {
		n := name
		if len(n) == 0 {
			continue
		}
		if n[0] != '#' {
			n = "#" + n
		}
		h := sha256.Sum256([]byte(n))
		key := h[:16]
		mac := hmac.New(sha256.New, key)
		mac.Write(msg)
		sig := mac.Sum(nil)
		code := binary.LittleEndian.Uint16(sig[:2])
		if code == 0 {
			code = 1
		} else if code == 0xFFFF {
			code = 0xFFFE
		}
		if code == pktCode {
			return n
		}
	}
	return ""
}

// ComputeContentHash returns a 16-char SHA-256-based dedup key.
func ComputeContentHash(rawHex string) string {
	buf, err := hex.DecodeString(rawHex)
	if err != nil || len(buf) < 2 {
		if len(rawHex) >= 16 {
			return rawHex[:16]
		}
		return rawHex
	}
	hdrByte := buf[0]
	off := 1
	if isTransportRoute(int(hdrByte & 0x03)) {
		off += 4
	}
	if off >= len(buf) {
		if len(rawHex) >= 16 {
			return rawHex[:16]
		}
		return rawHex
	}
	pb := buf[off]
	off++
	hs := int((pb>>6)&0x3) + 1
	hc := int(pb & 0x3F)
	off += hs * hc
	if off > len(buf) {
		if len(rawHex) >= 16 {
			return rawHex[:16]
		}
		return rawHex
	}
	payloadType := (hdrByte >> 2) & 0x0F
	toHash := []byte{payloadType}
	if int(payloadType) == PayloadTRACE {
		toHash = append(toHash, pb, 0x00)
	}
	toHash = append(toHash, buf[off:]...)
	h := sha256.Sum256(toHash)
	return hex.EncodeToString(h[:])[:16]
}

// AdvertRole maps advert flags to a role string.
func AdvertRole(f *AdvertFlags) string {
	if f == nil {
		return "companion"
	}
	switch f.Type {
	case 0:
		return "none"
	case 1:
		return "companion"
	case 2:
		return "repeater"
	case 3:
		return "room"
	case 4:
		return "sensor"
	default:
		return fmt.Sprintf("type-%d", f.Type)
	}
}

// ValidateAdvert returns false if the advert payload has obviously bad data.
func ValidateAdvert(p *Payload) (bool, string) {
	if p == nil || p.Error != "" {
		if p != nil {
			return false, p.Error
		}
		return false, "nil"
	}
	if len(p.PubKey) < 16 {
		return false, "pubkey too short"
	}
	allZero := true
	for _, c := range p.PubKey {
		if c != '0' {
			allZero = false
			break
		}
	}
	if allZero {
		return false, "pubkey all zeros"
	}
	if p.Lat != nil && (math.IsNaN(*p.Lat) || math.IsInf(*p.Lat, 0) || *p.Lat < -90 || *p.Lat > 90) {
		return false, "invalid lat"
	}
	if p.Lon != nil && (math.IsNaN(*p.Lon) || math.IsInf(*p.Lon, 0) || *p.Lon < -180 || *p.Lon > 180) {
		return false, "invalid lon"
	}
	return true, ""
}

// PayloadJSON serializes a payload to JSON string for storage.
func PayloadJSON(p *Payload) string {
	b, _ := json.Marshal(p)
	return string(b)
}

func sanitizeName(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c == '\t' || c == '\n' || (c >= 0x20 && c != 0x7f) {
			b.WriteRune(c)
		}
	}
	return b.String()
}
