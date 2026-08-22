// Decisoes do login do aluno, separadas do Electron para poderem ser medidas.
//
// Duas perguntas, e as duas ja deram errado em maquina real:
//   1. Vale tentar de novo? Um tropeco de rede custava ao aluno uma tentativa
//      inteira de login — ele digitava a senha, tomava erro, digitava outra
//      vez e entrava. Repetir e trabalho do aplicativo, nao dele.
//   2. Da para dizer que a matricula nao esta ativa? Essa e uma acusacao
//      pesada, e o codigo antigo a produzia para QUALQUER resposta que nao
//      fosse 5xx — inclusive token recusado por relogio fora de hora.

export type MemberEntitlement = 'active' | 'inactive' | 'network';

// Servidor ocupado, fora do ar ou pedindo calma: e transitorio.
// 4xx (fora do 429) e decisao do servidor sobre o pedido — repetir nao muda.
export function transientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Espera entre tentativas. Tres no total: cobre DNS frio, troca de rede e um
// 429 curto sem deixar o aluno esperando quando o erro e definitivo.
export const RETRY_DELAYS_MS = [400, 1_200];

// "Sua matricula nao esta ativa" so pode sair de uma resposta VALIDA que nao
// trouxe matricula. Qualquer outra coisa e tropeco, e tropeco se tenta de
// novo — na duvida, o aluno espera alguns segundos em vez de ser barrado.
export function entitlementFrom(
  ok: boolean,
  hasActiveEnrollment: boolean,
): MemberEntitlement {
  if (!ok) return 'network';
  return hasActiveEnrollment ? 'active' : 'inactive';
}

// A matricula que da direito ao Edvid: ativa, dentro da validade e do curso
// certo. O slug e o estavel; o titulo cobre o curso recriado com slug novo.
export function enrollmentGrantsAccess(
  row: { status?: string; expires_at?: string | null; course?: { slug?: string; title?: string } | null },
  now: number,
  slugs: ReadonlySet<string>,
  title: string,
): boolean {
  if ((row.status ?? '') !== 'active') return false;
  const expires = row.expires_at ?? '';
  if (expires && Date.parse(expires) <= now) return false;
  const slug = (row.course?.slug ?? '').toLocaleLowerCase('pt-BR');
  const courseTitle = (row.course?.title ?? '').toLocaleLowerCase('pt-BR');
  return slugs.has(slug) || courseTitle === title;
}
