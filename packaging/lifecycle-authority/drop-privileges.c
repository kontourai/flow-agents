#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Installed root-owned beside the coordinator.  argv is: uid gid program ... */
int main(int argc, char **argv) {
  if (argc < 4) { fputs("usage: flow-agents-lifecycle-drop-v1 UID GID PROGRAM [ARG...]\n", stderr); return 64; }
  char *end = NULL;
  unsigned long uid = strtoul(argv[1], &end, 10); if (!end || *end) return 64;
  end = NULL; unsigned long gid = strtoul(argv[2], &end, 10); if (!end || *end) return 64;
  if (setgroups(0, NULL) != 0 || setgid((gid_t)gid) != 0 || setuid((uid_t)uid) != 0) { perror("privilege drop"); return 77; }
  execv(argv[3], argv + 3); perror("execv"); return 127;
}
