cmake_minimum_required(VERSION 3.24)

# Arcade FFB Helper: SDL3 wheel force feedback for the arcade web ports in the user's browser.
#   cmake -S . -B build && cmake --build build --config Release
# Output in out/: Windows ArcadeFFBHelper.exe (a single file), macOS "Arcade FFB Helper.app".
# SDL3 is built from source and linked statically on every platform.

if(APPLE)
  if(NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "" FORCE)
  endif()
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "" FORCE)
endif()
# Windows: the C runtime inside the exe too (no Visual C++ Redistributable needed).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(arcade_ffb_helper VERSION 0.2.0 LANGUAGES C)

set(SDL3_VERSION 3.4.20)
set(OUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/out")

# The settings page is compiled in.
set(UI_HTML "${CMAKE_CURRENT_SOURCE_DIR}/ui/index.html")
set(UI_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/ui_page.h")
add_custom_command(OUTPUT "${UI_HEADER}"
  COMMAND ${CMAKE_COMMAND} -DIN=${UI_HTML} -DOUT=${UI_HEADER} -P "${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake"
  DEPENDS "${UI_HTML}" "${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake"
  COMMENT "Embedding the settings page")

set(SOURCES src/main.c src/ffb_device.c src/server.c src/updater.c "${UI_HEADER}")

if(APPLE)
  # App icon: assets/icon-mac.png -> AppIcon.icns (sips + iconutil, both part of macOS).
  set(ICONSET "${CMAKE_CURRENT_BINARY_DIR}/AppIcon.iconset")
  set(ICNS "${CMAKE_CURRENT_BINARY_DIR}/AppIcon.icns")
  set(PNG "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon-mac.png")
  add_custom_command(OUTPUT "${ICNS}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${ICONSET}"
    COMMAND sips -z 16 16 "${PNG}" --out "${ICONSET}/icon_16x16.png" > /dev/null
    COMMAND sips -z 32 32 "${PNG}" --out "${ICONSET}/icon_16x16@2x.png" > /dev/null
    COMMAND sips -z 32 32 "${PNG}" --out "${ICONSET}/icon_32x32.png" > /dev/null
    COMMAND sips -z 64 64 "${PNG}" --out "${ICONSET}/icon_32x32@2x.png" > /dev/null
    COMMAND sips -z 128 128 "${PNG}" --out "${ICONSET}/icon_128x128.png" > /dev/null
    COMMAND sips -z 256 256 "${PNG}" --out "${ICONSET}/icon_128x128@2x.png" > /dev/null
    COMMAND sips -z 256 256 "${PNG}" --out "${ICONSET}/icon_256x256.png" > /dev/null
    COMMAND sips -z 512 512 "${PNG}" --out "${ICONSET}/icon_256x256@2x.png" > /dev/null
    COMMAND sips -z 512 512 "${PNG}" --out "${ICONSET}/icon_512x512.png" > /dev/null
    COMMAND ${CMAKE_COMMAND} -E copy "${PNG}" "${ICONSET}/icon_512x512@2x.png"
    COMMAND iconutil -c icns "${ICONSET}" -o "${ICNS}"
    DEPENDS "${PNG}")
  set_source_files_properties("${ICNS}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  add_executable(arcade_ffb_helper MACOSX_BUNDLE ${SOURCES} "${ICNS}")
  set_target_properties(arcade_ffb_helper PROPERTIES
    OUTPUT_NAME "Arcade FFB Helper"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
    MACOSX_BUNDLE_GUI_IDENTIFIER "local.arcade.ffbhelper"
    MACOSX_BUNDLE_BUNDLE_NAME "Arcade FFB Helper"
    MACOSX_BUNDLE_ICON_FILE "AppIcon"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}")
elseif(WIN32)
  add_executable(arcade_ffb_helper WIN32 ${SOURCES} assets/app.rc)
  set_target_properties(arcade_ffb_helper PROPERTIES OUTPUT_NAME "ArcadeFFBHelper")
  # winhttp: the update check and download (updater.c), part of Windows.
  target_link_libraries(arcade_ffb_helper PRIVATE ws2_32 winhttp)
  set_source_files_properties(assets/app.rc PROPERTIES COMPILE_DEFINITIONS
    "HELPER_VERSION_MAJOR=${PROJECT_VERSION_MAJOR};HELPER_VERSION_MINOR=${PROJECT_VERSION_MINOR};HELPER_VERSION_PATCH=${PROJECT_VERSION_PATCH};HELPER_VERSION_STRING=\"${PROJECT_VERSION}\"")
else()
  add_executable(arcade_ffb_helper ${SOURCES})
endif()
target_include_directories(arcade_ffb_helper PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_compile_definitions(arcade_ffb_helper PRIVATE HELPER_VERSION="${PROJECT_VERSION}")

# SDL3 from the official source release, static.
include(FetchContent)
set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SDL_INSTALL OFF CACHE BOOL "" FORCE)
# Only what the helper uses: joystick, haptic, events, tray (video), no audio/render/gpu/camera.
set(SDL_AUDIO OFF CACHE BOOL "" FORCE)
set(SDL_RENDER OFF CACHE BOOL "" FORCE)
set(SDL_GPU OFF CACHE BOOL "" FORCE)
set(SDL_CAMERA OFF CACHE BOOL "" FORCE)
set(SDL_SENSOR ON CACHE BOOL "" FORCE)
FetchContent_Declare(SDL3
  URL "https://github.com/libsdl-org/SDL/releases/download/release-${SDL3_VERSION}/SDL3-${SDL3_VERSION}.tar.gz"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(SDL3)
target_link_libraries(arcade_ffb_helper PRIVATE SDL3::SDL3-static)

if(APPLE)
  add_custom_command(TARGET arcade_ffb_helper POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E remove_directory "${OUT_DIR}/Arcade FFB Helper.app"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "$<TARGET_BUNDLE_DIR:arcade_ffb_helper>" "${OUT_DIR}/Arcade FFB Helper.app")
else()
  add_custom_command(TARGET arcade_ffb_helper POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:arcade_ffb_helper> "${OUT_DIR}")
endif()

if(MSVC)
  target_compile_options(arcade_ffb_helper PRIVATE /W3 /utf-8)
  target_compile_definitions(arcade_ffb_helper PRIVATE _CRT_SECURE_NO_WARNINGS _WINSOCK_DEPRECATED_NO_WARNINGS)
else()
  target_compile_options(arcade_ffb_helper PRIVATE -Wall -O2)
endif()
