cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(espforge)
target_sources(app PRIVATE src/main.c src/status.c src/status_format.c
                          src/credentials.c src/wireless.c src/storage.c)
target_include_directories(app PRIVATE src)
