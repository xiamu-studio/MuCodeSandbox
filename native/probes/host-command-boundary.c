#include <arpa/inet.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int tcp(int family, int port) {
    int fd = socket(family, SOCK_STREAM, 0), ok = 0;
    if (fd < 0) return 0;
    if (family == AF_INET) {
        struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(port)};
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        ok = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0;
    } else {
        struct sockaddr_in6 address = {.sin6_family = AF_INET6, .sin6_port = htons(port)};
        inet_pton(AF_INET6, "::1", &address.sin6_addr);
        ok = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0;
    }
    close(fd);
    return ok;
}
int main(int argc, char **argv) {
    if (argc != 6) return 2;
    int fd = open(argv[1], O_RDONLY), outside_read = fd >= 0;
    if (fd >= 0) { char byte; outside_read = read(fd, &byte, 1) == 1; close(fd); }
    fd = open(argv[2], O_WRONLY | O_APPEND);
    int project_write = fd >= 0;
    if (fd >= 0) { project_write = write(fd, "MU_PROBE_WRITE\n", 15) == 15; close(fd); }
    int ipv4 = tcp(AF_INET, atoi(argv[3])), ipv6 = tcp(AF_INET6, atoi(argv[4]));
    fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(atoi(argv[5]))};
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    int udp = fd >= 0 && sendto(fd, "MU_UDP", 6, 0, (struct sockaddr *)&address, sizeof(address)) == 6;
    if (fd >= 0) close(fd);
    int status = 0;
    pid_t child = fork();
    if (child == 0) {
        int null = open("/dev/null", O_WRONLY);
        dup2(null, STDOUT_FILENO);
        execl("/bin/echo", "echo", "UNAPPROVED_CHILD", NULL);
        _exit(111);
    }
    if (child > 0) waitpid(child, &status, 0);
    int executed = child > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    child = fork();
    if (child == 0) _exit(tcp(AF_INET, atoi(argv[3])) ? 0 : 112);
    if (child > 0) waitpid(child, &status, 0);
    int child_network = child > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    printf("{\"outsideRead\":%d,\"projectWrite\":%d,\"ipv4\":%d,\"ipv6\":%d,\"udp\":%d,\"unapprovedExec\":%d,\"childNetwork\":%d}\n",
           outside_read, project_write, ipv4, ipv6, udp, executed, child_network);
    return 0;
}
