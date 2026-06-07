package geo
import "testing"
func TestSmoke(t *testing.T){
  cases := map[string]struct{lat,lon float64; want string}{
    "Warsaw":{52.23,21.01,"PL"}, "Bratislava":{48.15,17.11,"SK"},
    "Budapest":{47.50,19.04,"HU"}, "Krakow":{50.06,19.94,"PL"},
    "Berlin":{52.52,13.40,"DE"}, "midSea":{0,0,""},
  }
  for n,c := range cases {
    if got := CountryAt(c.lat,c.lon); got != c.want {
      t.Errorf("%s: got %q want %q", n, got, c.want)
    }
  }
}
