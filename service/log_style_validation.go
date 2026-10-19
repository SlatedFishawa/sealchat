package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"path"
	"regexp"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"golang.org/x/image/font/sfnt"
	_ "golang.org/x/image/webp"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

type LogStyleAsset struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	MIME   string `json:"mime"`
	SHA256 string `json:"sha256"`
}
type LogStyleRule struct {
	MessageType string `json:"messageType,omitempty"`
	IdentityKey string `json:"identityKey,omitempty"`
	VariantKey  string `json:"variantKey,omitempty"`
	TemplateID  string `json:"templateId"`
}
type LogStylePackage struct {
	SchemaVersion      int               `json:"schemaVersion"`
	ID                 string            `json:"id"`
	Version            string            `json:"version"`
	Name               string            `json:"name"`
	License            string            `json:"license"`
	MinRendererVersion string            `json:"minRendererVersion"`
	Tokens             map[string]any    `json:"tokens"`
	Templates          map[string]string `json:"templates"`
	CSS                string            `json:"css"`
	Rules              []LogStyleRule    `json:"rules"`
	SettingsSchema     map[string]any    `json:"settingsSchema"`
	Assets             []LogStyleAsset   `json:"assets"`
}

var logStyleKey = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)
var logAssetID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$`)
var logSemver = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func logTemplateError() error {
	return logError("INVALID_TEMPLATE", "样式包、模板、CSS 或资源无效")
}

// ValidateLogStyle is shared by ZIP import, JSON versions and release builds.
// Assets are authoritative bytes, never client supplied MIME/hash assertions.
func ValidateLogStyle(p *LogStylePackage, assets map[string][]byte) error {
	if p.Tokens == nil || p.Rules == nil || p.Assets == nil {
		return logTemplateError()
	}
	if p.SchemaVersion != 1 || !logStyleKey.MatchString(p.ID) || !logSemver.MatchString(p.Version) || !logSemver.MatchString(p.MinRendererVersion) || strings.TrimSpace(p.Name) == "" || len([]rune(p.Name)) > 200 || len(p.License) > 200 || len(p.Templates) == 0 || len(p.Templates) > 64 || len(p.Assets) > 200 || len(p.Rules) > 1000 || len(p.Tokens) > 200 {
		return logTemplateError()
	}
	paths := map[string]bool{}
	ids := map[string]bool{}
	total := 0
	for i := range p.Assets {
		a := &p.Assets[i]
		b, ok := assets[a.ID]
		if !ok || !logAssetID.MatchString(a.ID) || ids[a.ID] || paths[a.Path] || !logAssetPath(a.Path) || len(b) == 0 {
			return logTemplateError()
		}
		ids[a.ID] = true
		paths[a.Path] = true
		total += len(b)
		if total > 50<<20 {
			return logError("TOO_LARGE", "资源超过 50MB")
		}
		mime := ""
		if cfg, format, err := image.DecodeConfig(bytes.NewReader(b)); err == nil {
			if cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 40000000 {
				return logTemplateError()
			}
			mime = map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}[format]
		} else if _, err := sfnt.Parse(b); err == nil {
			if bytes.HasPrefix(b, []byte("OTTO")) {
				mime = "font/otf"
			} else {
				mime = "font/ttf"
			}
		}
		if mime == "" || a.MIME != mime {
			return logTemplateError()
		}
		h := sha256.Sum256(b)
		a.SHA256 = hex.EncodeToString(h[:])
	}
	for key, v := range p.Tokens {
		if !logStyleKey.MatchString(key) {
			return logTemplateError()
		}
		switch value := v.(type) {
		case bool, float64:
		case string:
			if len(value) > 200 || strings.ContainsAny(value, ";{}\\<>@") || strings.ContainsAny(value, "()") {
				return logTemplateError()
			}
		default:
			return logTemplateError()
		}
	}
	if p.SettingsSchema == nil {
		return logTemplateError()
	}
	for key, raw := range p.SettingsSchema {
		if _, ok := p.Templates[key]; !ok {
			return logTemplateError()
		}
		schema, ok := raw.(map[string]any)
		if !ok {
			return logTemplateError()
		}
		if _, err := logResolveSettings(schema); err != nil {
			return err
		}
	}
	graph := map[string][]string{}
	for key, src := range p.Templates {
		if !logStyleKey.MatchString(key) || len(src) > 512<<10 {
			return logTemplateError()
		}
		fields := map[string]bool{}
		if schema, ok := p.SettingsSchema[key].(map[string]any); ok {
			if props, ok := schema["properties"].(map[string]any); ok {
				if custom, ok := props["props"].(map[string]any); ok {
					if properties, ok := custom["properties"].(map[string]any); ok {
						for name := range properties {
							if !logStyleKey.MatchString(name) {
								return logTemplateError()
							}
							fields["props."+name] = true
						}
					}
				}
			}
		}
		parts, err := logValidateHTML(src, fields)
		if err != nil {
			return err
		}
		graph[key] = parts
	}
	var visit func(string, map[string]bool, int) error
	expansions := 0
	visit = func(key string, stack map[string]bool, depth int) error {
		expansions++
		if expansions > 4096 {
			return logTemplateError()
		}
		parts, ok := graph[key]
		if !ok || stack[key] || depth > 8 {
			return logTemplateError()
		}
		stack[key] = true
		defer delete(stack, key)
		for _, part := range parts {
			if err := visit(part, stack, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for key := range graph {
		expansions = 0
		if err := visit(key, map[string]bool{}, 1); err != nil {
			return err
		}
	}
	for _, r := range p.Rules {
		if _, ok := p.Templates[r.TemplateID]; !ok {
			return logTemplateError()
		}
		if r.MessageType != "" && !strings.Contains("|ic|ooc|narration|dice|bot|image|unknown|", "|"+r.MessageType+"|") {
			return logTemplateError()
		}
		var slots func(string) int
		slots = func(key string) int {
			count := logBodySlots(p.Templates[key])
			for _, part := range graph[key] {
				count += slots(part)
			}
			return count
		}
		if slots(r.TemplateID) != 1 {
			return logTemplateError()
		}
	}
	return logValidateCSS(p.CSS, paths)
}

func logAssetPath(s string) bool {
	return len(s) < 300 && strings.HasPrefix(s, "assets/") && path.Clean(s) == s && !strings.ContainsAny(s, "\\\x00?#:") && !strings.HasSuffix(s, "/")
}

func logValidateHTML(src string, customFields map[string]bool) ([]string, error) {
	root := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(src), root)
	if err != nil {
		return nil, logTemplateError()
	}
	parts := []string{}
	count := 0
	fields := map[string]bool{"speaker.name": true, "speaker.color": true, "speaker.avatarUrl": true, "body": true, "plainText": true, "createdAt": true, "title": true, "subtitle": true, "caption": true, "label": true, "text": true, "pageNumber": true, "section.title": true}
	for _, name := range []string{"assetUrl", "content.assetUrl", "content.title", "content.subtitle", "content.caption", "content.label", "content.text", "whisper.targets", "quote.speaker", "quote.text"} {
		fields[name] = true
	}
	for name := range customFields {
		fields[name] = true
	}
	var walk func(*html.Node, int) error
	walk = func(n *html.Node, depth int) error {
		count++
		if depth > 32 || count > 4096 {
			return logTemplateError()
		}
		if n.Type == html.ElementNode {
			if n.Namespace != "" || !strings.Contains("|div|span|p|section|article|header|footer|main|aside|figure|figcaption|img|h1|h2|h3|h4|h5|h6|blockquote|strong|em|b|i|br|hr|ul|ol|li|table|thead|tbody|tr|td|th|", "|"+n.Data+"|") {
				return logTemplateError()
			}
			seen := map[string]bool{}
			for _, a := range n.Attr {
				if a.Namespace != "" || seen[a.Key] || len(a.Val) > 512 {
					return logTemplateError()
				}
				seen[a.Key] = true
				switch a.Key {
				case "class", "title", "alt", "role":
					if strings.ContainsAny(a.Val, "<>\\") {
						return logTemplateError()
					}
				case "data-log-text", "data-log-if":
					if !fields[a.Val] {
						return logTemplateError()
					}
				case "data-log-bind-src":
					if n.Data != "img" || (a.Val != "speaker.avatarUrl" && a.Val != "assetUrl" && a.Val != "content.assetUrl") {
						return logTemplateError()
					}
				case "data-log-slot":
					if a.Val != "body" || (n.Data != "div" && n.Data != "section") {
						return logTemplateError()
					}
				case "data-log-part":
					if !logStyleKey.MatchString(a.Val) {
						return logTemplateError()
					}
					parts = append(parts, a.Val)
				default:
					return logTemplateError()
				}
			}
		} else if n.Type != html.TextNode && n.Type != html.CommentNode {
			return logTemplateError()
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if err := walk(c, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, n := range nodes {
		if err := walk(n, 0); err != nil {
			return nil, err
		}
	}
	return parts, nil
}

func logValidateCSS(src string, assets map[string]bool) error {
	if len(src) > 512<<10 || strings.ContainsAny(src, "\\\x00<>") {
		return logTemplateError()
	}
	// The grammar parser preserves custom property values as raw tokens. Lex the
	// complete sheet too, so var() cannot smuggle a URL through such a value.
	lexer := css.NewLexer(parse.NewInputString(src))
	for {
		tt, data := lexer.Next()
		if tt == css.ErrorToken {
			if lexer.Err() != io.EOF {
				return logTemplateError()
			}
			break
		}
		v := strings.ToLower(string(data))
		if tt == css.BadURLToken || tt == css.BadStringToken {
			return logTemplateError()
		}
		if tt == css.FunctionToken {
			allowed := map[string]bool{"var(": true, "calc(": true, "min(": true, "max(": true, "clamp(": true, "rgb(": true, "rgba(": true, "hsl(": true, "hsla(": true, "counter(": true, "counters(": true, "linear-gradient(": true, "radial-gradient(": true, "repeating-linear-gradient(": true, "repeating-radial-gradient(": true, "format(": true, "supports(": true, "not(": true, "is(": true, "where(": true, "nth-child(": true, "nth-of-type(": true}
			if !allowed[v] {
				return logTemplateError()
			}
		}
		if tt == css.URLToken {
			u := strings.TrimSpace(string(data))
			if len(u) < 5 {
				return logTemplateError()
			}
			u = strings.Trim(strings.TrimSpace(u[4:len(u)-1]), "\"'")
			if !assets[u] {
				return logTemplateError()
			}
		}
	}
	p := css.NewParser(parse.NewInputString(src), false)
	for {
		g, _, data := p.Next()
		if g == css.ErrorGrammar {
			if p.Err() != io.EOF || p.HasParseError() {
				return logTemplateError()
			}
			return nil
		}
		name := strings.ToLower(string(data))
		if g == css.AtRuleGrammar || g == css.BeginAtRuleGrammar {
			if name != "@media" && name != "@page" && name != "@font-face" && name != "@supports" && name != "@top-left" && name != "@top-center" && name != "@top-right" && name != "@bottom-left" && name != "@bottom-center" && name != "@bottom-right" {
				return logTemplateError()
			}
		}
		if g == css.DeclarationGrammar && (name == "behavior" || name == "-moz-binding" || name == "all") {
			return logTemplateError()
		}
		for _, t := range p.Values() {
			v := strings.ToLower(string(t.Data))
			if t.TokenType == css.BadURLToken || t.TokenType == css.BadStringToken {
				return logTemplateError()
			}
			if t.TokenType == css.FunctionToken && (v == "expression(" || v == "url(" || v == "src(" || v == "image-set(" || v == "-webkit-image-set(" || v == "attr(") {
				return logTemplateError()
			}
			if t.TokenType == css.URLToken {
				u := strings.TrimSpace(string(t.Data))
				if len(u) < 5 {
					return logTemplateError()
				}
				u = strings.Trim(strings.TrimSpace(u[4:len(u)-1]), "\"'")
				if !assets[u] {
					return logTemplateError()
				}
			}
		}
	}
}

// A bounded, local schema subset prevents remote references and recursive schemas.
func logResolveSettings(value map[string]any) (*jsonschema.Resolved, error) {
	if value == nil || value["type"] != "object" || value["additionalProperties"] != false {
		return nil, logTemplateError()
	}
	var check func(any, int) error
	count := 0
	check = func(v any, depth int) error {
		count++
		if depth > 12 || count > 4096 {
			return logTemplateError()
		}
		switch x := v.(type) {
		case map[string]any:
			if x["type"] == "object" && x["additionalProperties"] != false {
				return logTemplateError()
			}
			for k, v := range x {
				if strings.HasPrefix(k, "$") && k != "$schema" {
					return logTemplateError()
				}
				if err := check(v, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, v := range x {
				if err := check(v, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(value, 0); err != nil {
		return nil, err
	}
	b, err := json.Marshal(value)
	if err != nil || len(b) > 512<<10 {
		return nil, logTemplateError()
	}
	var schema jsonschema.Schema
	if json.Unmarshal(b, &schema) != nil {
		return nil, logTemplateError()
	}
	r, err := schema.Resolve(nil)
	if err != nil {
		return nil, logTemplateError()
	}
	return r, nil
}

func logBodySlots(src string) int {
	z := html.NewTokenizer(strings.NewReader(src))
	count := 0
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			break
		}
		if kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			t := z.Token()
			for _, a := range t.Attr {
				if a.Key == "data-log-slot" && a.Val == "body" {
					count++
				}
			}
		}
	}
	return count
}

func LogStyleJSONSchema() ([]byte, error) {
	s, err := jsonschema.For[LogStylePackage](nil)
	if err != nil {
		return nil, err
	}
	return json.MarshalIndent(s, "", "  ")
}
