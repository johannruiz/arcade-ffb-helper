# cmake -DIN=<file> -DOUT=<header> -P embed.cmake  ->  static const char UI_PAGE[] = { ..., 0 };
file(READ "${IN}" hex HEX)
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
string(REGEX REPLACE "(0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,)" "\\1\n" bytes "${bytes}")
get_filename_component(dir "${OUT}" DIRECTORY)
file(MAKE_DIRECTORY "${dir}")
file(WRITE "${OUT}" "/* Generated from ui/index.html by embed.cmake */\nstatic const char UI_PAGE[] = {\n${bytes}0x00};\n")
