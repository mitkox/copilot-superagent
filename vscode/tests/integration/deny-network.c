#include <stddef.h>
#include <errno.h>
#include <unistd.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/filter.h>
#include <linux/audit.h>
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported network-denied fixture architecture
#endif
#include <linux/seccomp.h>
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, n, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EACCES)
int main(int argc,char **argv){
 if(argc<2)return 2;
 struct sock_filter f[]={
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,NATIVE_ARCH,1,0),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
 BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
 DENY(__NR_socket),DENY(__NR_connect),DENY(__NR_sendto),DENY(__NR_sendmsg),DENY(__NR_sendmmsg),DENY(__NR_io_uring_setup),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
 struct sock_fprog p={sizeof(f)/sizeof(f[0]),f};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p)){perror("seccomp");return 3;}
 execv(argv[1],argv+1);perror("execv");return 4;
}
