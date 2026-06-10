import React from 'react'
import * as FlagComponents from 'country-flag-icons/react/3x2'

// Maps common IATA airport codes to ISO 3166-1 alpha-2 country codes.
const IATA_CC: Record<string, string> = {
  // Poland
  WAW:'PL', KRK:'PL', GDN:'PL', KTW:'PL', WRO:'PL', POZ:'PL', LCJ:'PL', RZE:'PL', BZG:'PL', SZZ:'PL',
  WMI:'PL', LUZ:'PL', RDO:'PL', SZY:'PL', IEG:'PL', OSZ:'PL', OSP:'PL', CZW:'PL',
  // UK
  LHR:'GB', LGW:'GB', STN:'GB', LTN:'GB', MAN:'GB', BHX:'GB', EDI:'GB', GLA:'GB', BRS:'GB', NCL:'GB', LBA:'GB', LPL:'GB', ABZ:'GB', BFS:'GB',
  // Germany
  FRA:'DE', MUC:'DE', DUS:'DE', BER:'DE', HAM:'DE', STR:'DE', CGN:'DE', NUE:'DE', LEJ:'DE', HAJ:'DE',
  // France
  CDG:'FR', ORY:'FR', NCE:'FR', LYS:'FR', MRS:'FR', TLS:'FR', BOD:'FR', NTE:'FR', LIL:'FR', BIA:'FR',
  // Netherlands
  AMS:'NL', EIN:'NL', RTM:'NL', GRQ:'NL', MST:'NL',
  // Spain
  MAD:'ES', BCN:'ES', PMI:'ES', AGP:'ES', ALC:'ES', SVQ:'ES', VLC:'ES', BIO:'ES', TFS:'ES', LPA:'ES', ACE:'ES', FUE:'ES',
  // Italy
  FCO:'IT', MXP:'IT', LIN:'IT', VCE:'IT', NAP:'IT', CIA:'IT', BLQ:'IT', PSA:'IT', PMO:'IT', CTA:'IT', BGY:'IT',
  // Austria
  VIE:'AT', GRZ:'AT', INN:'AT', SZG:'AT', LNZ:'AT',
  // Switzerland
  ZUR:'CH', GVA:'CH', BSL:'CH', ZRH:'CH',
  // Belgium
  BRU:'BE', CRL:'BE', LGG:'BE',
  // Portugal
  LIS:'PT', OPO:'PT', FAO:'PT', FNC:'PT',
  // Czech Republic
  PRG:'CZ', BRQ:'CZ', OSR:'CZ',
  // Hungary
  BUD:'HU', DEB:'HU',
  // Romania
  OTP:'RO', CLJ:'RO', TSR:'RO', IAS:'RO',
  // Bulgaria
  SOF:'BG', VAR:'BG', BOJ:'BG',
  // Croatia
  ZAG:'HR', SPU:'HR', DBV:'HR', ZAD:'HR',
  // Slovakia
  BTS:'SK', KSC:'SK',
  // Slovenia
  LJU:'SI',
  // Serbia
  BEG:'RS',
  // Ukraine
  KBP:'UA', LWO:'UA', HRK:'UA', ODS:'UA',
  // Greece
  ATH:'GR', SKG:'GR', HER:'GR', RHO:'GR', CFU:'GR', CHQ:'GR', KGS:'GR', ZTH:'GR',
  // Turkey
  IST:'TR', SAW:'TR', ESB:'TR', ADB:'TR', AYT:'TR', DLM:'TR', BJV:'TR',
  // Russia
  SVO:'RU', DME:'RU', VKO:'RU', LED:'RU', OVB:'RU', SVX:'RU', AER:'RU',
  // Scandinavia
  OSL:'NO', BGO:'NO', TRD:'NO', SVG:'NO', BOO:'NO',
  ARN:'SE', GOT:'SE', MMX:'SE', BMA:'SE',
  CPH:'DK', BLL:'DK', AAL:'DK', AAR:'DK',
  HEL:'FI', TMP:'FI', TKU:'FI', OUL:'FI',
  REK:'IS', KEF:'IS',
  // Baltic states
  RIX:'LV', TLL:'EE', VNO:'LT',
  // Belarus
  MSQ:'BY',
  // Moldova
  KIV:'MD',
  // Caucasus
  TBS:'GE', EVN:'AM', GYD:'AZ',
  // Central Asia
  ALA:'KZ', NQZ:'KZ', TSE:'KZ', TAS:'UZ', FRU:'KG',
  // USA
  JFK:'US', LGA:'US', EWR:'US', LAX:'US', SFO:'US', SJC:'US', OAK:'US', ORD:'US', MDW:'US',
  ATL:'US', DFW:'US', IAH:'US', MIA:'US', SEA:'US', BOS:'US', DCA:'US', IAD:'US', BWI:'US',
  DEN:'US', PHX:'US', LAS:'US', MSP:'US', DTW:'US', PHL:'US', CLT:'US', SLC:'US', PDX:'US',
  SAN:'US', TPA:'US', MCO:'US', HNL:'US', ANC:'US', BNA:'US', STL:'US', MCI:'US', RDU:'US',
  // Canada
  YYZ:'CA', YUL:'CA', YVR:'CA', YYC:'CA', YOW:'CA', YEG:'CA', YHZ:'CA', YWG:'CA',
  // Mexico
  MEX:'MX', CUN:'MX', GDL:'MX', MTY:'MX', TIJ:'MX', SJD:'MX',
  // Brazil
  GRU:'BR', GIG:'BR', BSB:'BR', SSA:'BR', FOR:'BR', REC:'BR', POA:'BR', CNF:'BR', CGB:'BR',
  // Argentina
  EZE:'AR', AEP:'AR', COR:'AR', MDZ:'AR',
  // Colombia
  BOG:'CO', MDE:'CO', CTG:'CO', CLO:'CO',
  // Chile
  SCL:'CL', PMC:'CL',
  // Peru
  LIM:'PE',
  // Venezuela
  CCS:'VE',
  // Ecuador
  UIO:'EC', GYE:'EC',
  // Japan
  NRT:'JP', HND:'JP', KIX:'JP', ITM:'JP', NGO:'JP', CTS:'JP', FUK:'JP', OKA:'JP',
  // China
  PEK:'CN', PKX:'CN', PVG:'CN', SHA:'CN', CAN:'CN', SZX:'CN', CTU:'CN', XIY:'CN', WUH:'CN', KMG:'CN',
  // South Korea
  ICN:'KR', GMP:'KR', PUS:'KR',
  // Taiwan
  TPE:'TW', TSA:'TW', KHH:'TW',
  // Hong Kong
  HKG:'HK',
  // Singapore
  SIN:'SG',
  // Thailand
  BKK:'TH', DMK:'TH', HKT:'TH', CNX:'TH', USM:'TH',
  // Vietnam
  HAN:'VN', SGN:'VN', DAD:'VN',
  // Malaysia
  KUL:'MY', SZB:'MY', PEN:'MY', BKI:'MY', KCH:'MY',
  // Indonesia
  CGK:'ID', DPS:'ID', SUB:'ID', UPG:'ID', KNO:'ID',
  // Philippines
  MNL:'PH', CEB:'PH', DVO:'PH',
  // India
  DEL:'IN', BOM:'IN', MAA:'IN', BLR:'IN', CCU:'IN', HYD:'IN', AMD:'IN', PNQ:'IN', GOI:'IN', COK:'IN',
  // Pakistan
  KHI:'PK', LHE:'PK', ISB:'PK',
  // Bangladesh
  DAC:'BD',
  // Sri Lanka
  CMB:'LK',
  // UAE
  DXB:'AE', AUH:'AE', SHJ:'AE',
  // Saudi Arabia
  RUH:'SA', JED:'SA', DMM:'SA',
  // Qatar
  DOH:'QA',
  // Kuwait
  KWI:'KW',
  // Bahrain
  BAH:'BH',
  // Oman
  MCT:'OM',
  // Israel
  TLV:'IL',
  // Jordan
  AMM:'JO',
  // Lebanon
  BEY:'LB',
  // Egypt
  CAI:'EG', HRG:'EG', SSH:'EG',
  // Morocco
  CMN:'MA', RAK:'MA', AGA:'MA', FEZ:'MA',
  // Tunisia
  TUN:'TN', DJE:'TN',
  // South Africa
  JNB:'ZA', CPT:'ZA', DUR:'ZA',
  // Kenya
  NBO:'KE', MBA:'KE',
  // Ethiopia
  ADD:'ET',
  // Nigeria
  LOS:'NG', ABV:'NG',
  // Ghana
  ACC:'GH',
  // Tanzania
  DAR:'TZ', JRO:'TZ',
  // Australia
  SYD:'AU', MEL:'AU', BNE:'AU', PER:'AU', ADL:'AU', CBR:'AU', OOL:'AU', HBA:'AU', DRW:'AU',
  // New Zealand
  AKL:'NZ', WLG:'NZ', CHC:'NZ', ZQN:'NZ',
}

/** Returns the ISO 3166-1 alpha-2 country code for an IATA airport code, or '' if unknown. */
export function iataCountry(iata: string | null | undefined): string {
  if (!iata) return ''
  return IATA_CC[iata.toUpperCase()] ?? ''
}

export function isIataCode(iata: string | null | undefined): boolean {
  return !!iata && /^[A-Za-z]{3}$/.test(iata)
}

const FLAGS = FlagComponents as Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>

function renderFlag(cc: string, size: number, style?: React.CSSProperties) {
  const FlagSvg = FLAGS[cc.toUpperCase()]
  if (!FlagSvg) return null
  return React.createElement(FlagSvg, {
    style: { width: Math.round(size * 1.33), height: size, display: 'inline', verticalAlign: 'middle', borderRadius: 2, flexShrink: 0, ...style },
  })
}

/** Inline SVG flag for an IATA airport code. Renders nothing for unknown codes. */
export function IataFlag({ iata, size = 16, style }: { iata: string | null | undefined; size?: number; style?: React.CSSProperties }) {
  const cc = iataCountry(iata)
  if (!cc) return null
  return renderFlag(cc, size, style)
}

/** Inline SVG flag for a raw ISO 3166-1 alpha-2 country code (e.g. "GB", "PL"). */
export function FlagByCC({ cc, size = 16, style }: { cc: string; size?: number; style?: React.CSSProperties }) {
  return renderFlag(cc, size, style)
}
