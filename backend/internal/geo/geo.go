// Package geo resolves a lat/lon coordinate to its ISO 3166-1 alpha-2 country
// code using embedded Natural Earth 1:50m country polygons and ray-casting
// point-in-polygon. Used for geographic ("strict") region filtering, where an
// item's country is decided by where it physically is — not by who observed it.
package geo

import (
	_ "embed"
	"encoding/json"
	"sync"
)

//go:embed countries.min.json
var countriesJSON []byte

type polygon struct {
	rings                          [][][2]float64 // [0]=outer ring, rest=holes; each point is [lon,lat]
	minLon, minLat, maxLon, maxLat float64
}

type country struct {
	cc    string
	polys []polygon
}

var (
	once      sync.Once
	countries []country

	// ccCache memoizes resolved country codes on a ~11 m grid (4 decimal places).
	// CountryAt is re-run for the whole node fleet on every periodic reload, and
	// node positions are effectively static, so the point-in-polygon scan only
	// needs to run once per distinct location.
	ccMu    sync.RWMutex
	ccCache = make(map[[2]int32]string)
)

func load() {
	var raw []struct {
		CC    string           `json:"cc"`
		Polys [][][][2]float64 `json:"polys"` // polygon → ring → point[lon,lat]
	}
	if err := json.Unmarshal(countriesJSON, &raw); err != nil {
		return
	}
	for _, c := range raw {
		ct := country{cc: c.CC}
		for _, pl := range c.Polys {
			if len(pl) == 0 || len(pl[0]) == 0 {
				continue
			}
			p := polygon{rings: pl, minLon: 1e18, minLat: 1e18, maxLon: -1e18, maxLat: -1e18}
			for _, pt := range pl[0] { // bbox from outer ring
				if pt[0] < p.minLon {
					p.minLon = pt[0]
				}
				if pt[0] > p.maxLon {
					p.maxLon = pt[0]
				}
				if pt[1] < p.minLat {
					p.minLat = pt[1]
				}
				if pt[1] > p.maxLat {
					p.maxLat = pt[1]
				}
			}
			ct.polys = append(ct.polys, p)
		}
		countries = append(countries, ct)
	}
}

// CountryAt returns the ISO 3166-1 alpha-2 code of the country containing the
// coordinate, or "" if it falls outside all borders (open sea / unmapped).
// Results are memoized per ~11 m grid cell.
func CountryAt(lat, lon float64) string {
	once.Do(load)
	key := [2]int32{int32(lat * 1e4), int32(lon * 1e4)}
	ccMu.RLock()
	cc, ok := ccCache[key]
	ccMu.RUnlock()
	if ok {
		return cc
	}
	cc = countryAtUncached(lat, lon)
	ccMu.Lock()
	ccCache[key] = cc
	ccMu.Unlock()
	return cc
}

func countryAtUncached(lat, lon float64) string {
	for i := range countries {
		for j := range countries[i].polys {
			p := &countries[i].polys[j]
			if lon < p.minLon || lon > p.maxLon || lat < p.minLat || lat > p.maxLat {
				continue
			}
			if pointInPolygon(lon, lat, p.rings) {
				return countries[i].cc
			}
		}
	}
	return ""
}

// pointInPolygon reports whether the point is inside the outer ring and not in
// any hole.
func pointInPolygon(lon, lat float64, rings [][][2]float64) bool {
	if len(rings) == 0 || !inRing(lon, lat, rings[0]) {
		return false
	}
	for _, h := range rings[1:] {
		if inRing(lon, lat, h) {
			return false
		}
	}
	return true
}

// inRing is the standard even-odd ray-casting test (ring points are [lon,lat]).
func inRing(lon, lat float64, r [][2]float64) bool {
	in := false
	n := len(r)
	j := n - 1
	for i := range n {
		xi, yi := r[i][0], r[i][1]
		xj, yj := r[j][0], r[j][1]
		if (yi > lat) != (yj > lat) {
			if lon < (xj-xi)*(lat-yi)/(yj-yi)+xi {
				in = !in
			}
		}
		j = i
	}
	return in
}
