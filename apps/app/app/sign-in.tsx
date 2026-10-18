import { RequestCodeBody, SignInCode } from '@beer-die/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiRequestError, getMe, requestCode, verifyCode } from '../src/api/client';

// An invite token (32 random bytes, base64url). Anything else in `?invite=` is ignored, so
// the parameter can only ever lead back to a join screen.
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Wait a while and try again.';
    if (error.code === 'INVALID_CODE') return 'That code is wrong or has expired.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export default function SignIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { invite } = useLocalSearchParams<{ invite?: string }>();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const send = useMutation({
    mutationFn: (address: string) => requestCode(address),
    onSuccess: () => {
      setCode('');
      setStep('code');
    },
  });
  const verify = useMutation({
    mutationFn: () => verifyCode(email.trim(), code),
    onSuccess: async () => {
      // /me carries the memberships Home needs, so load it before leaving this screen.
      await queryClient.fetchQuery({ queryKey: ['me'], queryFn: getMe });
      router.replace(invite && INVITE_TOKEN.test(invite) ? `/join/${invite}` : '/');
    },
  });

  // Same validators as the server, for instant feedback; the server checks again.
  const emailValid = RequestCodeBody.safeParse({ email: email.trim() }).success;
  const codeValid = SignInCode.safeParse(code).success;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Sign in' }} />
      {step === 'email' ? (
        <>
          <Text style={styles.label} nativeID="email-label">
            Email
          </Text>
          <TextInput
            testID="email-input"
            aria-labelledby="email-label"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            inputMode="email"
            onSubmitEditing={() => emailValid && send.mutate(email.trim())}
          />
          <Pressable
            testID="send-code"
            role="button"
            style={[styles.button, (!emailValid || send.isPending) && styles.disabled]}
            disabled={!emailValid || send.isPending}
            onPress={() => send.mutate(email.trim())}
          >
            <Text style={styles.buttonText}>{send.isPending ? 'Sending…' : 'Email me a code'}</Text>
          </Pressable>
          {send.isError && <Text style={styles.error}>{messageFor(send.error)}</Text>}
        </>
      ) : (
        <>
          <Text style={styles.label} nativeID="code-label">
            Enter the 6-digit code sent to {email.trim()}
          </Text>
          <TextInput
            testID="code-input"
            aria-labelledby="code-label"
            style={styles.input}
            value={code}
            onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            onSubmitEditing={() => codeValid && verify.mutate()}
          />
          <Pressable
            testID="verify-code"
            role="button"
            style={[styles.button, (!codeValid || verify.isPending) && styles.disabled]}
            disabled={!codeValid || verify.isPending}
            onPress={() => verify.mutate()}
          >
            <Text style={styles.buttonText}>{verify.isPending ? 'Signing in…' : 'Sign in'}</Text>
          </Pressable>
          {verify.isError && <Text style={styles.error}>{messageFor(verify.error)}</Text>}
          <Pressable
            role="button"
            onPress={() => {
              verify.reset();
              setStep('email');
            }}
          >
            <Text style={styles.link}>Use a different email or resend</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, maxWidth: 420 },
  label: { fontSize: 16 },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 12, fontSize: 18 },
  button: { backgroundColor: '#1d4ed8', borderRadius: 8, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#b91c1c' },
  link: { color: '#1d4ed8', textAlign: 'center', padding: 8 },
});
