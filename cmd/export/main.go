// Command export reads a bbolt database written by the original Go service and
// emits its links bucket as NDJSON and as idempotent SQL for import into D1.
//
// This is the only remaining Go program in the repository. It exists so that an
// archived short.db stays readable after the service itself has been decommissioned.
//
//	go run ./cmd/export -db short.db -ndjson links.ndjson -sql links.sql
//
// The stderr summary line is the integrity checksum for the migration: compare
// links/slug_bytes/url_bytes against the imported table with
//
//	SELECT count(*), sum(length(CAST(slug AS BLOB))), sum(length(CAST(url AS BLOB))) FROM links;
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// The bucket the decommissioned Go service wrote; there was never another.
const linksBucket = "links"

func main() {
	dbPath := flag.String("db", "short.db", "path to the bbolt database (opened read-only)")
	ndjsonPath := flag.String("ndjson", "", "write NDJSON records here (optional)")
	sqlPath := flag.String("sql", "", "write INSERT OR IGNORE statements here (optional)")
	table := flag.String("table", "links", "target table name for the emitted SQL")
	batch := flag.Int("batch", 200, "rows per multi-VALUES INSERT statement")
	flag.Parse()

	if *batch < 1 {
		log.Fatal("-batch must be >= 1")
	}

	// ReadOnly takes a shared flock, which is incompatible with the exclusive lock a
	// running short.service holds. Pointing this at a live database is meant to fail
	// loudly rather than read a torn page set — take a copy with the service stopped.
	db, err := bolt.Open(*dbPath, 0o400, &bolt.Options{ReadOnly: true, Timeout: 5 * time.Second})
	if err != nil {
		log.Fatalf("open %s: %v (is short.service still running? stop it and copy the file)", *dbPath, err)
	}
	defer db.Close()

	ndjsonW, closeNDJSON := openOut(*ndjsonPath)
	defer closeNDJSON()
	sqlW, closeSQL := openOut(*sqlPath)
	defer closeSQL()

	enc := json.NewEncoder(ndjsonW)
	// Keep &, < and > literal so URLs round-trip byte-identically into the parity
	// script; Go's encoder escapes them for HTML embedding by default.
	enc.SetEscapeHTML(false)

	var links, slugBytes, urlBytes, nonASCII int
	pending := 0

	err = db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(linksBucket))
		if b == nil {
			return fmt.Errorf("bucket %q not found in %s", linksBucket, *dbPath)
		}
		return b.ForEach(func(k, v []byte) error {
			// A NUL byte would silently truncate a SQLite string literal. Values here
			// all came through url.Parse, which rejects control characters, so this
			// should never fire — but failing loudly beats corrupting the only copy.
			if bytes.IndexByte(k, 0) >= 0 || bytes.IndexByte(v, 0) >= 0 {
				return fmt.Errorf("NUL byte in record %q; refusing to emit SQL", k)
			}
			slug, dest := string(k), string(v)
			links++
			slugBytes += len(k)
			urlBytes += len(v)
			if !isASCII(k) || !isASCII(v) {
				nonASCII++
				fmt.Fprintf(os.Stderr, "warn: non-ASCII record: slug=%q url=%q\n", slug, dest)
			}

			if err := enc.Encode(record{Slug: slug, URL: dest}); err != nil {
				return err
			}

			if pending == 0 {
				fmt.Fprintf(sqlW, "INSERT OR IGNORE INTO %s (slug, url) VALUES\n", *table)
			} else {
				fmt.Fprint(sqlW, ",\n")
			}
			fmt.Fprintf(sqlW, "  ('%s','%s')", quote(slug), quote(dest))
			pending++
			if pending == *batch {
				fmt.Fprint(sqlW, ";\n")
				pending = 0
			}
			return nil
		})
	})
	if err != nil {
		log.Fatalf("export: %v", err)
	}
	if pending > 0 {
		fmt.Fprint(sqlW, ";\n")
	}

	fmt.Fprintf(os.Stderr, "links=%d slug_bytes=%d url_bytes=%d non_ascii=%d\n",
		links, slugBytes, urlBytes, nonASCII)
}

type record struct {
	Slug string `json:"slug"`
	URL  string `json:"url"`
}

// The only escaping a SQLite string literal needs.
func quote(s string) string { return strings.ReplaceAll(s, "'", "''") }

func isASCII(b []byte) bool {
	for _, c := range b {
		if c >= 0x80 {
			return false
		}
	}
	return true
}

// openOut returns a buffered writer for path, or io.Discard when path is empty.
func openOut(path string) (io.Writer, func()) {
	if path == "" {
		return io.Discard, func() {}
	}
	f, err := os.Create(path)
	if err != nil {
		log.Fatalf("create %s: %v", path, err)
	}
	w := bufio.NewWriter(f)
	return w, func() {
		if err := w.Flush(); err != nil {
			log.Fatalf("flush %s: %v", path, err)
		}
		if err := f.Close(); err != nil {
			log.Fatalf("close %s: %v", path, err)
		}
	}
}
