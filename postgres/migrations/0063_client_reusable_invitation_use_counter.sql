-- 客户端注册在生产上必然失败（PostgreSQL 42501 insufficient_privilege）。
--
-- 0055 给可复用邀请链接加了 use_count / last_used_at，注册服务里对应地写了一句
-- 直接 UPDATE invitations。但 invitations 是**客户端角色被 REVOKE ALL 的表**——
-- 它存着全部邀请码，最小权限设计刻意不让公网进程碰它
-- （deploy/postgres/least-privilege-roles.sql）。
--
-- 于是这条 UPDATE 在开发机（超级用户）上一路绿灯，一到生产就 42501，
-- 而客户看到的只是「注册失败」。整个注册流程被这一行挡死。
--
-- 修法不是给客户端角色开 invitations 的写权限——那等于把最小权限设计拆掉，
-- 让公网进程能读写所有邀请码。改为和其它客户端写操作一致，收进一个
-- SECURITY DEFINER 函数，只暴露「给这一条可复用链接的计数 +1」这一个动作。

CREATE OR REPLACE FUNCTION client_record_reusable_invitation_use(
  invitation_id_input text, used_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH counted AS (
    UPDATE invitations
       SET use_count = use_count + 1,
           last_used_at = used_at_input,
           updated_at = used_at_input::text
     -- 只作用于可复用链接。一次性码的语义是 status='used'，
     -- 由 client_claim_registration_invitation 负责，两者不可互相顶替。
     WHERE id = invitation_id_input AND kind = 'employee_reusable'
     RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM counted)
$function$;

-- 与 0043 的收敛一致：函数必须由迁移角色拥有，且执行权限只给客户端 auth 角色。
DO $$
DECLARE
  target text;
BEGIN
  FOR target IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('agentnovas_client_auth', 'agentnovas_client_web')
  LOOP
    -- 不写死 public.：迁移在测试里被应用到独立 schema，写死会让整条迁移链在那里失败。
    -- 不带 schema 时由 search_path 解析，与 0043 的 ::regprocedure 做法一致。
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION client_record_reusable_invitation_use(text,timestamptz) TO %I',
      target
    );
  END LOOP;
END $$;

-- 计数失败不该让注册失败，但也不该静默——它是发现链接外泄的唯一信号
-- （一条本该发给三五个人的链接突然涨到几百次）。函数返回布尔值，调用方据此判断。
