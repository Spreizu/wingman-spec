package harness

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// A JSON file the user may have edited is changed only when its text is exactly what JSON.stringify(v, null,
// indent) writes for it (indent detected: a tab or N spaces; final newline and CRLF kept). Then the only
// difference is the added entry. Comments, a compact or hand-aligned layout or invalid JSON: left untouched.

// Patch results.
const (
	Created = "created"
	Written = "written"
	Manual  = "manual" // the caller tells the user what to add by hand
	Same    = "unchanged"
)

// jv is a JSON value that keeps its object key order.
type jv struct {
	obj  []kv // kind '{'
	arr  []*jv
	kind byte // '{', '[' or 0 for a scalar
	raw  string
}

type kv struct {
	k string
	v *jv
}

func (v *jv) get(k string) *jv {
	for _, e := range v.obj {
		if e.k == k {
			return e.v
		}
	}
	return nil
}

// child returns v[k], set to def when missing or not of def's kind.
func (v *jv) child(k string, def *jv) *jv {
	for i, e := range v.obj {
		if e.k == k {
			if e.v.kind != def.kind {
				v.obj[i].v = def
				return def
			}
			return e.v
		}
	}
	v.obj = append(v.obj, kv{k, def})
	return def
}

func obj(pairs ...any) *jv {
	o := &jv{kind: '{'}
	for i := 0; i+1 < len(pairs); i += 2 {
		o.obj = append(o.obj, kv{pairs[i].(string), pairs[i+1].(*jv)})
	}
	return o
}

func arr(items ...*jv) *jv { return &jv{kind: '[', arr: items} }

func str(s string) *jv {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(s)
	return &jv{raw: strings.TrimSuffix(b.String(), "\n")}
}

func decode(d *json.Decoder) (*jv, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := &jv{kind: '{'}
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := decode(d)
				if err != nil {
					return nil, err
				}
				o.obj = append(o.obj, kv{kt.(string), v})
			}
			_, err := d.Token()
			return o, err
		case '[':
			a := &jv{kind: '['}
			for d.More() {
				v, err := decode(d)
				if err != nil {
					return nil, err
				}
				a.arr = append(a.arr, v)
			}
			_, err := d.Token()
			return a, err
		}
		return nil, errors.New("unexpected delimiter")
	case string:
		return str(x), nil
	case json.Number:
		return &jv{raw: x.String()}, nil
	case bool:
		if x {
			return &jv{raw: "true"}, nil
		}
		return &jv{raw: "false"}, nil
	case nil:
		return &jv{raw: "null"}, nil
	}
	return nil, errors.New("unexpected token")
}

func parseJSON(text string) (*jv, error) {
	d := json.NewDecoder(strings.NewReader(text))
	d.UseNumber()
	v, err := decode(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

func (v *jv) write(b *strings.Builder, ind, cur string) {
	switch v.kind {
	case '{':
		if len(v.obj) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{")
		for i, e := range v.obj {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString("\n" + cur + ind + str(e.k).raw + ": ")
			e.v.write(b, ind, cur+ind)
		}
		b.WriteString("\n" + cur + "}")
	case '[':
		if len(v.arr) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[")
		for i, e := range v.arr {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString("\n" + cur + ind)
			e.write(b, ind, cur+ind)
		}
		b.WriteString("\n" + cur + "]")
	default:
		b.WriteString(v.raw)
	}
}

func indentOf(text string) string {
	for l := range strings.SplitSeq(text, "\n") {
		t := strings.TrimLeft(l, " \t")
		if t == "" || len(t) == len(l) {
			continue
		}
		if l[0] == '\t' {
			return "\t"
		}
		return strings.Repeat(" ", len(l)-len(strings.TrimLeft(l, " ")))
	}
	return "  "
}

func render(v *jv, text string) string {
	var b strings.Builder
	v.write(&b, indentOf(text), "")
	s := b.String()
	if strings.Contains(text, "\r\n") {
		s = strings.ReplaceAll(s, "\n", "\r\n")
	}
	if strings.HasSuffix(text, "\r\n") {
		s += "\r\n"
	} else if strings.HasSuffix(text, "\n") {
		s += "\n"
	}
	return s
}

// patchJSON changes file through change (which reports whether it changed anything). A missing file starts as {}.
func patchJSON(file string, change func(root *jv) bool) (string, error) {
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		root := &jv{kind: '{'}
		change(root)
		return Created, writeFile(file, []byte(render(root, "\n")))
	} else if err != nil {
		return "", err
	}
	text := string(b)
	root, err := parseJSON(text)
	if err != nil || root.kind != '{' || render(root, text) != text {
		return Manual, nil
	}
	if !change(root) {
		return Same, nil
	}
	return Written, writeFile(file, []byte(render(root, text)))
}
