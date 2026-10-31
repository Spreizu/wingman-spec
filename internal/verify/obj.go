package verify

import (
	"bytes"
	"encoding/json"
)

// Obj is a JSON object that keeps its key order (the v1 outputs did), so the output reads the same.
// A value of Skip leaves the key out (JavaScript's undefined); nil prints null.
type Obj struct {
	keys []string
	vals map[string]any
}

type skip struct{}

// Skip leaves a key out of an Obj.
var Skip = skip{}

// O builds an object from key, value pairs.
func O(kv ...any) *Obj {
	o := &Obj{vals: map[string]any{}}
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// Set adds or replaces a key (a new key goes last).
func (o *Obj) Set(k string, v any) *Obj {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
	return o
}

// Get returns a value (nil when absent).
func (o *Obj) Get(k string) any { return o.vals[k] }

// Has reports a key that is set and not Skip.
func (o *Obj) Has(k string) bool { v, ok := o.vals[k]; return ok && v != Skip }

// Merge copies the keys of p into o.
func (o *Obj) Merge(p *Obj) *Obj {
	if p == nil {
		return o
	}
	for _, k := range p.keys {
		o.Set(k, p.vals[k])
	}
	return o
}

// MarshalJSON writes the keys in order.
func (o *Obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	n := 0
	for _, k := range o.keys {
		v := o.vals[k]
		if v == Skip {
			continue
		}
		if n > 0 {
			b.WriteByte(',')
		}
		n++
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshal(v)
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// If is v when cond holds, else Skip.
func If(cond bool, v any) any {
	if cond {
		return v
	}
	return Skip
}

// NonEmpty is xs, or Skip when it is empty.
func NonEmpty[T any](xs []T) any {
	if len(xs) == 0 {
		return Skip
	}
	return xs
}

// orNil is s, or nil when it is "".
func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func list[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}
