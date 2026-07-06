package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

var linksBucket = []byte("links")

const (
	slugAlphabet   = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	randomSlugLen  = 6
	maxRequestBody = 4 << 10
)

var slugPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Paths that can never be used as slugs because they are routed elsewhere.
var reservedSlugs = map[string]bool{
	"api":     true,
	"healthz": true,
}

type server struct {
	db      *bolt.DB
	baseURL string
}

func main() {
	port := envOr("PORT", "8081")
	dataFile := envOr("DATA_FILE", "short.db")
	baseURL := strings.TrimRight(envOr("BASE_URL", "https://short.latam-tools.com.br"), "/")

	db, err := bolt.Open(dataFile, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		log.Fatalf("open %s: %v", dataFile, err)
	}
	defer db.Close()

	if err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(linksBucket)
		return err
	}); err != nil {
		log.Fatalf("init bucket: %v", err)
	}

	s := &server{db: db, baseURL: baseURL}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "short — sessionless URL shortener. POST /api/links {\"url\": \"https://...\"} to create a link.\n")
	})
	mux.HandleFunc("POST /api/links", s.createLink)
	mux.HandleFunc("GET /{slug}", s.redirect)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	log.Printf("short listening on :%s (data: %s, base: %s)", port, dataFile, baseURL)
	log.Fatal(srv.ListenAndServe())
}

func (s *server) redirect(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	var dest string
	s.db.View(func(tx *bolt.Tx) error {
		if v := tx.Bucket(linksBucket).Get([]byte(slug)); v != nil {
			dest = string(v)
		}
		return nil
	})
	if dest == "" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, dest, http.StatusMovedPermanently)
}

type createRequest struct {
	URL  string `json:"url"`
	Slug string `json:"slug,omitempty"`
}

type createResponse struct {
	Slug     string `json:"slug"`
	ShortURL string `json:"short_url"`
}

func (s *server) createLink(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		httpError(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}

	if req.Slug != "" {
		if !slugPattern.MatchString(req.Slug) || reservedSlugs[req.Slug] {
			httpError(w, http.StatusBadRequest, "slug must match [A-Za-z0-9_-]{1,64} and not be reserved")
			return
		}
	}

	var slug string
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(linksBucket)
		if req.Slug != "" {
			if b.Get([]byte(req.Slug)) != nil {
				return errSlugTaken
			}
			slug = req.Slug
		} else {
			for {
				candidate, err := randomSlug()
				if err != nil {
					return err
				}
				if b.Get([]byte(candidate)) == nil && !reservedSlugs[candidate] {
					slug = candidate
					break
				}
			}
		}
		return b.Put([]byte(slug), []byte(u.String()))
	})
	switch {
	case errors.Is(err, errSlugTaken):
		httpError(w, http.StatusConflict, "slug already in use")
		return
	case err != nil:
		log.Printf("create link: %v", err)
		httpError(w, http.StatusInternalServerError, "internal error")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(createResponse{
		Slug:     slug,
		ShortURL: s.baseURL + "/" + slug,
	})
}

var errSlugTaken = errors.New("slug taken")

func randomSlug() (string, error) {
	buf := make([]byte, randomSlugLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, randomSlugLen)
	for i, b := range buf {
		out[i] = slugAlphabet[int(b)%len(slugAlphabet)]
	}
	return string(out), nil
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
