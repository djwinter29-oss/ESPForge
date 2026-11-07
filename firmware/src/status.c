#include "espforge.h"
#include "status_format.h"

#include <zephyr/kernel.h>

int status_json(char *buffer, size_t size)
{
	return status_format(buffer, size, k_uptime_get());
}
