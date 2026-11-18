#!/bin/sh
exec 3<&0
input_matched=false
cwd_matched=false
# Linux cannot reopen socket stdin; only reopen the reference pipe.
if printf 'aws_secret_input_fixture_secret_9b7e\000\303\251\360\237\231\202\015\012"literal\134bytes"' | /usr/bin/cmp -s - /dev/fd/4 4<&0 <&3; then
	input_matched=true
fi
if [ . -ef "$1" ]; then
	cwd_matched=true
fi
printf '{"inputMatched":%s,"cwdMatched":%s}\n' "$input_matched" "$cwd_matched"
if [ "$input_matched" = true ] && [ "$cwd_matched" = true ]; then
	exit 0
fi
exit 1
