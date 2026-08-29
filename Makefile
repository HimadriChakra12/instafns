# Builds tools/build (a small MuJS-hosted compiler) and runs it to produce
# dist/instafn.user.js. No npm, no node, no bundler framework -- just a C
# program that runs a JS transform script under MuJS.
#
# Prereqs: libmujs (Debian/Ubuntu: `apt install libmujs-dev`; otherwise
#   git clone https://github.com/ccxvii/mujs.git && cd mujs && make release
#   sudo make prefix=/usr/local install
# ), and any C99 compiler.

CC       ?= cc
CFLAGS   += -std=c99 -O2 -Wall -Wextra
LDLIBS   += -lmujs -lm

BIN      = tools/build
SRC      = tools/build.c
OUT      = dist/instafn.user.js

.PHONY: all clean rebuild

all: $(OUT)

$(BIN): $(SRC) tools/build.h
	$(CC) $(CFLAGS) -o $(BIN) $(SRC) $(LDLIBS)

$(OUT): $(BIN) tools/transform.js $(shell find src vendor -name '*.js' -o -name '*.css')
	./$(BIN) tools/transform.js

rebuild:
	./$(BIN) tools/transform.js

clean:
	rm -f $(BIN)
	rm -rf build dist/instafn.user.js
