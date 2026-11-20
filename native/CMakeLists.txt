cmake_minimum_required(VERSION 3.24)

# macOS: one universal binary (Apple Silicon + Intel), runs on macOS 11+.
if(APPLE)
  if(NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "" FORCE)
  endif()
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "" FORCE)
endif()

project(ffb_bridge C)

set(SDL3_VERSION 3.4.20)
set(OUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../bin")
add_executable(ffb_bridge ffb_bridge.c)

if(WIN32)
  # Windows: official prebuilt SDL3 (downloaded on first configure if missing).
  set(SDL3_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/SDL3-${SDL3_VERSION}")
  if(NOT EXISTS "${SDL3_ROOT}/cmake")
    set(zip "${CMAKE_CURRENT_BINARY_DIR}/SDL3-devel-VC.zip")
    file(DOWNLOAD "https://github.com/libsdl-org/SDL/releases/download/release-${SDL3_VERSION}/SDL3-devel-${SDL3_VERSION}-VC.zip" "${zip}" SHOW_PROGRESS STATUS st)
    list(GET st 0 code)
    if(NOT code EQUAL 0)
      message(FATAL_ERROR "SDL3 download failed: ${st}")
    endif()
    file(ARCHIVE_EXTRACT INPUT "${zip}" DESTINATION "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
  endif()
  set(SDL3_DIR "${SDL3_ROOT}/cmake")
  find_package(SDL3 REQUIRED CONFIG)
  target_link_libraries(ffb_bridge PRIVATE SDL3::SDL3)
  add_custom_command(TARGET ffb_bridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:ffb_bridge> "${OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:SDL3::SDL3> "${OUT_DIR}")
else()
  # macOS / Linux: SDL3 built from the official source release and linked statically,
  # so the bridge is a single self-contained binary.
  include(FetchContent)
  set(SDL_SHARED OFF CACHE BOOL "" FORCE)
  set(SDL_STATIC ON CACHE BOOL "" FORCE)
  set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
  set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SDL_INSTALL OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(SDL3
    URL "https://github.com/libsdl-org/SDL/releases/download/release-${SDL3_VERSION}/SDL3-${SDL3_VERSION}.tar.gz"
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  FetchContent_MakeAvailable(SDL3)
  target_link_libraries(ffb_bridge PRIVATE SDL3::SDL3-static)
  add_custom_command(TARGET ffb_bridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${OUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:ffb_bridge> "${OUT_DIR}")
endif()

if(MSVC)
  target_compile_options(ffb_bridge PRIVATE /W3 /utf-8)
  target_compile_definitions(ffb_bridge PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  target_compile_options(ffb_bridge PRIVATE -Wall -O2)
endif()
