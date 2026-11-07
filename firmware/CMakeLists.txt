cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(espforge)
target_sources(app PRIVATE
  src/main.c src/board.c src/usb_hid.c src/ble.c src/wifi.c src/telemetry.c src/storage.c
  src/control.c src/hid_reports.c src/wireless_auth.c src/wireless_stage.c src/sha256.c
  src/boot_config.c src/boot_flash.c src/system_clock.c)
target_include_directories(app PRIVATE src)
if(DEFINED ENV{ESPFORGE_VERSION} AND NOT "$ENV{ESPFORGE_VERSION}" STREQUAL "")
  if(NOT "$ENV{ESPFORGE_VERSION}" MATCHES "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
    message(FATAL_ERROR "ESPFORGE_VERSION must be MAJOR.MINOR.PATCH with no leading zeros")
  endif()
  target_compile_definitions(app PRIVATE "ESPFORGE_VERSION=\"$ENV{ESPFORGE_VERSION}\"")
endif()
