from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from rest_framework.views import APIView


@login_required
@some_cache_decorator
def profile(request, extra=None):
    return HttpResponse("me")


class Orders(APIView):
    # relies on the project default (IsAuthenticated in settings.py), which protects it the same way
    pass
