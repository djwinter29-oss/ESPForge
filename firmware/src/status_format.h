#ifndef ESPFORGE_STATUS_FORMAT_H
#define ESPFORGE_STATUS_FORMAT_H

#include <stddef.h>
#include <stdint.h>

int status_format(char *buffer, size_t size, int64_t uptime_ms);

#endif
