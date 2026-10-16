#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(void) {
  printf("%ld %ld %d\n", (long)getuid(), (long)geteuid(),
         prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
  return 0;
}
