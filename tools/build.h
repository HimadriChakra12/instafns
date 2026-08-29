#ifndef BUILD_H
#define BUILD_H

#define _POSIX_C_SOURCE 200809L /* strdup */

/*
 * build.h -- small C-side helpers for build.c. Unlike bundlejs's build.h,
 * this doesn't try to assemble the bundle itself (that part needs real
 * import/export handling, which is what tools/transform.js + MuJS are for);
 * this header only does the things plain C is actually good at: reading a
 * directory tree, slurping/writing files, and printing the userscript
 * metadata block. No fixed-size output buffer -- everything here grows
 * dynamically, since instafn's bundle is a lot bigger than a Makefile
 * constant should have to guess at.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <dirent.h>

/* ---- dynamic string list (for the .js file manifest) ------------------ */

typedef struct {
    char **items;
    size_t count;
    size_t cap;
} strlist_t;

static void strlist_init(strlist_t *l) {
    l->items = NULL; l->count = 0; l->cap = 0;
}

static void strlist_push(strlist_t *l, const char *s) {
    if (l->count == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 64;
        l->items = realloc(l->items, l->cap * sizeof(char *));
        if (!l->items) { perror("realloc"); exit(1); }
    }
    l->items[l->count++] = strdup(s);
}

static void strlist_free(strlist_t *l) {
    for (size_t i = 0; i < l->count; i++) free(l->items[i]);
    free(l->items);
    l->items = NULL; l->count = 0; l->cap = 0;
}

/* Recursively collect every *.js file under `root`, as paths relative to
 * `root` (POSIX separators). This is the one piece of filesystem walking
 * the whole build needs -- MuJS's sandboxed host deliberately doesn't get
 * readdir, per avroc's "three functions only" rule, so it happens here in
 * C and gets handed to transform.js as a plain manifest file. */
static void walk_js_files(const char *root, const char *relBase, strlist_t *out) {
    char full[4096];
    snprintf(full, sizeof(full), "%s/%s", root, relBase);

    DIR *d = opendir(full);
    if (!d) { fprintf(stderr, "build: cannot open dir %s\n", full); exit(1); }

    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;

        char relPath[4096];
        if (relBase[0])
            snprintf(relPath, sizeof(relPath), "%s/%s", relBase, ent->d_name);
        else
            snprintf(relPath, sizeof(relPath), "%s", ent->d_name);

        char childFull[4096];
        snprintf(childFull, sizeof(childFull), "%s/%s", root, relPath);

        struct stat st;
        if (stat(childFull, &st) != 0) continue;

        if (S_ISDIR(st.st_mode)) {
            walk_js_files(root, relPath, out);
        } else if (S_ISREG(st.st_mode)) {
            size_t len = strlen(relPath);
            if (len > 3 && strcmp(relPath + len - 3, ".js") == 0) {
                strlist_push(out, relPath);
            }
        }
    }
    closedir(d);
}

/* ---- file IO ------------------------------------------------------------ */

static char *build_read_file(const char *path, long *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "build: cannot read %s\n", path); exit(1); }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)len + 1);
    if (!buf) { perror("malloc"); exit(1); }
    size_t got = fread(buf, 1, (size_t)len, f);
    fclose(f);
    buf[got] = '\0';
    if (out_len) *out_len = (long)got;
    return buf;
}

static void build_write_file(const char *path, const char *data) {
    FILE *f = fopen(path, "wb");
    if (!f) { fprintf(stderr, "build: cannot write %s\n", path); exit(1); }
    fwrite(data, 1, strlen(data), f);
    fclose(f);
}

static void build_mkdir_p(const char *path) {
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    mkdir(tmp, 0755);
}

/* ---- userscript metadata header ---------------------------------------- */

typedef struct {
    const char *name;
    const char *namespace_;
    const char *version;
    const char *description;
    const char *author;
    const char *const *match;
    size_t match_count;
    const char *const *connect;
    size_t connect_count;
    const char *const *grant;
    size_t grant_count;
    const char *run_at;
} userscript_meta_t;

#define LISTOF(name, ...) \
    static const char *name[] = { __VA_ARGS__ }; \
    enum { name##_COUNT = sizeof(name) / sizeof(name[0]) }

/* Returns a malloc'd string -- caller frees. */
static char *build_userscript_header(const userscript_meta_t *m) {
    size_t cap = 4096;
    char *out = malloc(cap);
    size_t len = 0;

#define EMIT(...) do { \
        char line[1024]; \
        int n = snprintf(line, sizeof(line), __VA_ARGS__); \
        if (len + (size_t)n + 1 > cap) { cap *= 2; out = realloc(out, cap); } \
        memcpy(out + len, line, (size_t)n); \
        len += (size_t)n; \
        out[len] = '\0'; \
    } while (0)

    EMIT("// ==UserScript==\n");
    EMIT("// @name        %s\n", m->name);
    EMIT("// @namespace   %s\n", m->namespace_);
    EMIT("// @version     %s\n", m->version);
    EMIT("// @description %s\n", m->description);
    EMIT("// @author      %s\n", m->author);
    for (size_t i = 0; i < m->match_count; i++) EMIT("// @match       %s\n", m->match[i]);
    for (size_t i = 0; i < m->connect_count; i++) EMIT("// @connect     %s\n", m->connect[i]);
    for (size_t i = 0; i < m->grant_count; i++) EMIT("// @grant       %s\n", m->grant[i]);
    EMIT("// @run-at      %s\n", m->run_at);
    EMIT("// ==/UserScript==\n");

#undef EMIT
    return out;
}

#endif /* BUILD_H */
